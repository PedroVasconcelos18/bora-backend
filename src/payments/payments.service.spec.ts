import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { IPaymentProvider, PixChargeResult } from './interfaces/payment-provider.interface';
import { MercadoPagoAdapter } from './adapters/mercadopago.adapter';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let psp: jest.Mocked<IPaymentProvider>;
  let prisma: {
    participant: { findUnique: jest.Mock; update: jest.Mock };
    payment: { create: jest.Mock };
  };

  const chargeResult: PixChargeResult = {
    externalId: 'mp-external-id-123',
    qrCode: '00020126...copia-e-cola',
    qrCodeBase64: 'base64-qr-data',
    ticketUrl: 'https://www.mercadopago.com/ticket/123',
    expiresAt: new Date('2026-07-09T00:30:00.000Z'),
  };

  const waitingParticipant = {
    id: 'participant-1',
    challengeId: 'challenge-1',
    userId: 'user-1',
    status: 'INVITED',
    pixKey: null,
    challenge: {
      id: 'challenge-1',
      title: 'Corrida matinal',
      status: 'WAITING',
      collabAmount: 25 as unknown as number,
    },
    user: { id: 'user-1', email: 'joao@example.com', name: 'João' },
  };

  beforeEach(async () => {
    psp = {
      createPixCharge: jest.fn().mockResolvedValue(chargeResult),
      getPayment: jest.fn(),
    };

    prisma = {
      participant: {
        findUnique: jest.fn().mockResolvedValue(waitingParticipant),
        update: jest.fn().mockResolvedValue({ ...waitingParticipant, pixKey: 'joao@pix' }),
      },
      payment: {
        create: jest.fn().mockResolvedValue({
          id: 'payment-1',
          externalId: chargeResult.externalId,
          participantId: waitingParticipant.id,
          challengeId: waitingParticipant.challengeId,
          amount: waitingParticipant.challenge.collabAmount,
          status: 'PENDING',
        }),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: 'PAYMENT_PROVIDER', useValue: psp },
      ],
    }).compile();

    service = moduleRef.get(PaymentsService);
  });

  it('calls the injected provider and returns the QR result for a WAITING participant', async () => {
    const result = await service.createCashIn('participant-1');

    expect(psp.createPixCharge).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      qrCode: chargeResult.qrCode,
      qrCodeBase64: chargeResult.qrCodeBase64,
      ticketUrl: chargeResult.ticketUrl,
      expiresAt: chargeResult.expiresAt,
      paymentId: 'payment-1',
    });
  });

  it('persists a PENDING Payment row with the returned externalId, amount, participantId, and challengeId', async () => {
    await service.createCashIn('participant-1');

    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        externalId: chargeResult.externalId,
        participantId: waitingParticipant.id,
        challengeId: waitingParticipant.challengeId,
        amount: waitingParticipant.challenge.collabAmount,
        status: 'PENDING',
      }),
    });
  });

  it('throws when the participant challenge is not WAITING (pitfall M4)', async () => {
    prisma.participant.findUnique.mockResolvedValueOnce({
      ...waitingParticipant,
      challenge: { ...waitingParticipant.challenge, status: 'ACTIVE' },
    });

    await expect(service.createCashIn('participant-1')).rejects.toThrow(BadRequestException);
    expect(psp.createPixCharge).not.toHaveBeenCalled();
  });

  describe('MercadoPagoAdapter without MERCADOPAGO_ACCESS_TOKEN', () => {
    it('throws on createPixCharge rather than faking a QR', async () => {
      const config = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
      const adapter = new MercadoPagoAdapter(config);

      await expect(
        adapter.createPixCharge({
          amount: 25,
          description: 'Entrada',
          payerEmail: 'joao@example.com',
          externalReference: 'participant-1',
          expirationMinutes: 30,
          idempotencyKey: 'participant-1-123',
        }),
      ).rejects.toThrow('MERCADOPAGO_ACCESS_TOKEN');
    });
  });
});
