import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { IPaymentProvider, PixChargeResult } from './interfaces/payment-provider.interface';
import { MercadoPagoAdapter } from './adapters/mercadopago.adapter';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let psp: jest.Mocked<IPaymentProvider>;
  let config: { getOrThrow: jest.Mock };
  let tx: {
    payment: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    participant: { update: jest.Mock; count: jest.Mock };
    challenge: { update: jest.Mock; findUnique: jest.Mock };
    invite: { updateMany: jest.Mock };
    $executeRaw: jest.Mock;
  };
  let prisma: {
    participant: { findUnique: jest.Mock; update: jest.Mock };
    payment: { create: jest.Mock };
    $transaction: jest.Mock;
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

  const webhookSecret = 'test-webhook-secret-fixture';

  beforeEach(async () => {
    psp = {
      createPixCharge: jest.fn().mockResolvedValue(chargeResult),
      getPayment: jest.fn(),
    };

    config = {
      getOrThrow: jest.fn().mockReturnValue(webhookSecret),
    };

    tx = {
      payment: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      participant: {
        update: jest.fn(),
        count: jest.fn(),
      },
      challenge: {
        update: jest.fn(),
        findUnique: jest.fn(),
      },
      invite: {
        updateMany: jest.fn(),
      },
      $executeRaw: jest.fn().mockResolvedValue(0),
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
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) => callback(tx)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: 'PAYMENT_PROVIDER', useValue: psp },
      ],
    }).compile();

    service = moduleRef.get(PaymentsService);
  });

  describe('createCashIn', () => {
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
  });

  describe('MercadoPagoAdapter without MERCADOPAGO_ACCESS_TOKEN', () => {
    it('throws on createPixCharge rather than faking a QR', async () => {
      const adapterConfig = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
      const adapter = new MercadoPagoAdapter(adapterConfig);

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

  describe('verifySignature', () => {
    it('delegates to the HMAC util using MERCADOPAGO_WEBHOOK_SECRET from ConfigService', () => {
      const dataId = 'mp-external-id-123';
      const ts = '1704908010';
      const xRequestId = 'req-1';
      const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
      const v1 = createHmac('sha256', webhookSecret).update(manifest).digest('hex');
      const xSignature = `ts=${ts},v1=${v1}`;

      expect(service.verifySignature(xSignature, xRequestId, dataId)).toBe(true);
      expect(config.getOrThrow).toHaveBeenCalledWith('MERCADOPAGO_WEBHOOK_SECRET');
    });

    it('returns false for a tampered signature', () => {
      expect(service.verifySignature('ts=1,v1=deadbeef', 'req-1', 'mp-external-id-123')).toBe(false);
    });
  });

  describe('handleWebhook', () => {
    const existingPayment = {
      id: 'payment-1',
      externalId: 'mp-external-id-123',
      participantId: 'participant-1',
      challengeId: 'challenge-1',
      status: 'PENDING',
    };

    it('marks the matching Payment APPROVED and the Participant PAID + paidAt when GET /v1/payments status is approved', async () => {
      psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-1' });
      tx.payment.findUnique.mockResolvedValue(existingPayment);

      await service.handleWebhook('mp-external-id-123', { type: 'payment', data: { id: 'mp-external-id-123' } });

      expect(psp.getPayment).toHaveBeenCalledWith('mp-external-id-123');
      expect(tx.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'payment-1' },
          data: expect.objectContaining({ status: 'APPROVED', paidAt: expect.any(Date) }),
        }),
      );
      expect(tx.participant.update).toHaveBeenCalledWith({
        where: { id: 'participant-1' },
        data: { status: 'PAID', paidAt: expect.any(Date) },
      });
    });

    it('calls psp.getPayment (verify-via-API) before any Prisma write', async () => {
      const callOrder: string[] = [];
      psp.getPayment.mockImplementation(async () => {
        callOrder.push('getPayment');
        return { status: 'approved', externalReference: 'participant-1' };
      });
      prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
        callOrder.push('$transaction');
        return callback(tx);
      });
      tx.payment.findUnique.mockResolvedValue(existingPayment);

      await service.handleWebhook('mp-external-id-123', {});

      expect(callOrder).toEqual(['getPayment', '$transaction']);
    });

    it('is idempotent: called twice with the same approved dataId leaves exactly one PAID transition (second call is a no-op)', async () => {
      psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-1' });

      tx.payment.findUnique.mockResolvedValueOnce(existingPayment);
      await service.handleWebhook('mp-external-id-123', {});

      tx.payment.findUnique.mockResolvedValueOnce({ ...existingPayment, status: 'APPROVED' });
      await service.handleWebhook('mp-external-id-123', {});

      expect(tx.participant.update).toHaveBeenCalledTimes(1);
      expect(tx.payment.update).toHaveBeenCalledTimes(2); // 1 rawWebhookPayload write + 1 APPROVED write, from the FIRST call only
    });

    it('logs and does not throw or create a participant when no matching Payment row exists', async () => {
      psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'unknown-id' });
      tx.payment.findUnique.mockResolvedValue(null);

      await expect(service.handleWebhook('unknown-external-id', {})).resolves.toEqual({ activated: false });

      expect(tx.participant.update).not.toHaveBeenCalled();
      expect(tx.payment.update).not.toHaveBeenCalled();
    });

    it('returns activated: true when tryActivateChallenge performs the transition', async () => {
      psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-1' });
      tx.payment.findUnique.mockResolvedValue(existingPayment);
      tx.$executeRaw.mockResolvedValue(1);

      const result = await service.handleWebhook('mp-external-id-123', {});

      expect(result).toEqual({ activated: true });
    });
  });

  describe('tryActivateChallenge', () => {
    it('returns true exactly once when the atomic UPDATE reports exactly one row changed', async () => {
      tx.$executeRaw.mockResolvedValue(1);

      const result = await service.tryActivateChallenge(
        tx as unknown as Parameters<typeof service.tryActivateChallenge>[0],
        'challenge-1',
      );

      expect(result).toBe(true);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('returns false when the atomic UPDATE affects zero rows (not enough paid, or already activated)', async () => {
      tx.$executeRaw.mockResolvedValue(0);

      const result = await service.tryActivateChallenge(
        tx as unknown as Parameters<typeof service.tryActivateChallenge>[0],
        'challenge-1',
      );

      expect(result).toBe(false);
    });
  });

  describe('cancelChallenge', () => {
    it('sets the challenge CANCELLED, pending invites EXPIRED, and APPROVED payments REFUND_PENDING in a single $transaction (D-09/D-10/D-12)', async () => {
      await service.cancelChallenge('challenge-1', 'manual');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.challenge.update).toHaveBeenCalledWith({
        where: { id: 'challenge-1' },
        data: { status: 'CANCELLED' },
      });
      expect(tx.invite.updateMany).toHaveBeenCalledWith({
        where: { challengeId: 'challenge-1', status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      expect(tx.payment.updateMany).toHaveBeenCalledWith({
        where: { challengeId: 'challenge-1', status: 'APPROVED' },
        data: { status: 'REFUND_PENDING' },
      });
    });
  });

  describe('processDeadline', () => {
    it('is a no-op when the challenge is not WAITING (idempotent second run)', async () => {
      tx.challenge.findUnique.mockResolvedValue({ id: 'challenge-1', status: 'ACTIVE' });

      const result = await service.processDeadline('challenge-1');

      expect(result).toEqual({ action: 'none' });
      expect(tx.participant.count).not.toHaveBeenCalled();
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundException when the challenge does not exist', async () => {
      tx.challenge.findUnique.mockResolvedValue(null);

      await expect(service.processDeadline('missing-challenge')).rejects.toThrow(NotFoundException);
    });

    it('activates via the same atomic conditional UPDATE when >=3 paid (reuses tryActivateChallenge)', async () => {
      tx.challenge.findUnique.mockResolvedValue({ id: 'challenge-1', status: 'WAITING' });
      tx.participant.count.mockResolvedValue(3);
      tx.$executeRaw.mockResolvedValue(1);

      const result = await service.processDeadline('challenge-1');

      expect(result).toEqual({ action: 'activated' });
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('cancels into the refund queue when <3 paid at the deadline', async () => {
      tx.challenge.findUnique.mockResolvedValue({ id: 'challenge-1', status: 'WAITING' });
      tx.participant.count.mockResolvedValue(2);

      const result = await service.processDeadline('challenge-1');

      expect(result).toEqual({ action: 'cancelled' });
      // cancelChallenge runs its own top-level $transaction — the deadline
      // check ran in the first $transaction, cancelChallenge in a second.
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(tx.challenge.update).toHaveBeenCalledWith({
        where: { id: 'challenge-1' },
        data: { status: 'CANCELLED' },
      });
      expect(tx.payment.updateMany).toHaveBeenCalledWith({
        where: { challengeId: 'challenge-1', status: 'APPROVED' },
        data: { status: 'REFUND_PENDING' },
      });
    });

    it('running processDeadline twice on the same challenge produces the same terminal result (idempotent)', async () => {
      tx.challenge.findUnique.mockResolvedValueOnce({ id: 'challenge-1', status: 'WAITING' });
      tx.participant.count.mockResolvedValue(2);

      const first = await service.processDeadline('challenge-1');
      expect(first).toEqual({ action: 'cancelled' });

      // Second run: challenge is now CANCELLED — no-op.
      tx.challenge.findUnique.mockResolvedValueOnce({ id: 'challenge-1', status: 'CANCELLED' });
      const second = await service.processDeadline('challenge-1');

      expect(second).toEqual({ action: 'none' });
      // No additional cancellation side effects on the second, idempotent run.
      expect(tx.challenge.update).toHaveBeenCalledTimes(1);
      expect(tx.payment.updateMany).toHaveBeenCalledTimes(1);
    });
  });
});
