import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InvitesService } from './invites.service';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { IPaymentProvider, PixChargeResult } from '../payments/interfaces/payment-provider.interface';

/**
 * InvitesService.acceptAndPay — the SECOND caller of PaymentsService.createCashIn.
 *
 * Why this file exists: both the duplicate-charge guards (#1a "already PAID"
 * and #1b "reuse the live cobrança") deliberately live inside createCashIn
 * rather than in a caller, precisely because there are two callers —
 * ParticipantsService.payEntry (the creator) and this one (the invitee).
 * Guarding only payEntry would have left the invite path wide open. These
 * tests wire the REAL PaymentsService into the REAL InvitesService so that
 * claim is proven end-to-end through the invite flow, not merely asserted.
 *
 * The PSP is mocked throughout — no Mercado Pago call is ever made.
 */
describe('InvitesService — charge path (createCashIn convergence)', () => {
  let invites: InvitesService;
  let psp: jest.Mocked<IPaymentProvider>;

  const chargeResult: PixChargeResult = {
    externalId: 'mp-external-new',
    qrCode: '00020126...fresh-copia-e-cola',
    qrCodeBase64: 'fresh-base64-qr',
    ticketUrl: 'https://www.mercadopago.com/ticket/fresh',
    expiresAt: new Date(Date.now() + 30 * 60_000),
  };

  const invite = {
    id: 'invite-1',
    token: 'invite-token-1',
    targetEmail: 'maria@example.com',
    challengeId: 'challenge-1',
    status: 'PENDING',
  };

  const invitedUser = { id: 'user-2', email: 'maria@example.com', pixKey: null, pixKeys: [] };

  const invitedParticipant = {
    id: 'participant-2',
    challengeId: 'challenge-1',
    userId: 'user-2',
    status: 'INVITED',
    pixKey: null,
    challenge: {
      id: 'challenge-1',
      title: 'Corrida matinal',
      status: 'WAITING',
      collabAmount: 25 as unknown as number,
    },
    user: invitedUser,
  };

  const livePendingPayment = {
    id: 'payment-live',
    externalId: 'mp-external-live',
    participantId: 'participant-2',
    status: 'PENDING',
    qrCode: '00020126...stored-copia-e-cola',
    qrCodeBase64: 'stored-base64-qr',
    ticketUrl: 'https://www.mercadopago.com/ticket/live',
    expiresAt: new Date(Date.now() + 22 * 60_000),
    createdAt: new Date(Date.now() - 8 * 60_000),
  };

  let prisma: {
    invite: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock; update: jest.Mock };
    participant: { findUnique: jest.Mock; update: jest.Mock };
    payment: { findFirst: jest.Mock; create: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    psp = {
      createPixCharge: jest.fn().mockResolvedValue(chargeResult),
      getPayment: jest.fn(),
    };

    const tx = {
      invite: { update: jest.fn().mockResolvedValue({ ...invite, status: 'ACCEPTED' }) },
      participant: {
        // Already a participant — accept()'s idempotent branch.
        findUnique: jest.fn().mockResolvedValue({
          id: invitedParticipant.id,
          challengeId: invitedParticipant.challengeId,
          status: 'INVITED',
          paidAt: null,
        }),
        create: jest.fn(),
      },
    };

    prisma = {
      invite: { findUnique: jest.fn().mockResolvedValue(invite) },
      user: {
        findUnique: jest.fn().mockResolvedValue(invitedUser),
        update: jest.fn().mockResolvedValue({}),
      },
      participant: {
        findUnique: jest.fn().mockResolvedValue(invitedParticipant),
        update: jest.fn().mockResolvedValue(invitedParticipant),
      },
      payment: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'payment-fresh' }),
      },
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) => callback(tx)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        InvitesService,
        // The REAL service — the point is that the guards inside it apply to
        // this caller too, so it must not be stubbed out.
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('https://app.example.com'),
            getOrThrow: jest.fn().mockReturnValue('test-webhook-secret-fixture'),
          },
        },
        { provide: 'EMAIL_PROVIDER', useValue: { sendInvite: jest.fn() } },
        { provide: 'PAYMENT_PROVIDER', useValue: psp },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    invites = moduleRef.get(InvitesService);
  });

  describe('acceptAndPay', () => {
    it('creates a charge when the invitee has no live cobrança yet (happy path unchanged)', async () => {
      const result = await invites.acceptAndPay('invite-token-1', 'user-2');

      expect(psp.createPixCharge).toHaveBeenCalledTimes(1);
      expect(result.qrCode).toBe(chargeResult.qrCode);
      expect(result.participantId).toBe('participant-2');
    });

    it('#1b: reuses the invitee\'s live PENDING cobrança instead of minting a second Mercado Pago charge', async () => {
      prisma.payment.findFirst.mockResolvedValue(livePendingPayment);

      const result = await invites.acceptAndPay('invite-token-1', 'user-2');

      // The reuse lives in createCashIn, so it reaches the invite path for
      // free — this asserts that wiring, which is the reason for the
      // placement decision.
      expect(psp.createPixCharge).not.toHaveBeenCalled();
      expect(prisma.payment.create).not.toHaveBeenCalled();
      expect(result.qrCode).toBe(livePendingPayment.qrCode);
      expect(result.paymentId).toBe(livePendingPayment.id);
      expect(result.participantId).toBe('participant-2');
    });

    it('#1b: falls through to a new charge when the invitee\'s PENDING cobrança has expired', async () => {
      // findFirst filters on `expiresAt: { gt: now }` in Postgres, so an
      // expired row simply never comes back — the caller then charges anew.
      prisma.payment.findFirst.mockResolvedValue(null);

      const result = await invites.acceptAndPay('invite-token-1', 'user-2');

      expect(psp.createPixCharge).toHaveBeenCalledTimes(1);
      expect(result.qrCode).toBe(chargeResult.qrCode);
    });

    it('#1a: refuses with 409 when the invitee already paid — the guard covers this caller too', async () => {
      prisma.participant.findUnique.mockResolvedValue({
        ...invitedParticipant,
        status: 'PAID',
      });

      await expect(invites.acceptAndPay('invite-token-1', 'user-2')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(psp.createPixCharge).not.toHaveBeenCalled();
    });
  });
});
