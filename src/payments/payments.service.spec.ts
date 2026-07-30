import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHmac } from 'crypto';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { IPaymentProvider, PixChargeResult } from './interfaces/payment-provider.interface';
import { MercadoPagoAdapter } from './adapters/mercadopago.adapter';
import { PaymentNotFoundError } from './errors/payment-not-found.error';

/** The Payment columns the #1b reuse path reads. */
interface StoredPayment {
  id: string;
  externalId: string | null;
  participantId: string;
  status: string;
  qrCode: string | null;
  qrCodeBase64: string | null;
  ticketUrl: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

/** The subset of Prisma's `where` that the #1b reuse query builds. */
interface ReuseWhere {
  participantId?: string;
  status?: string;
  qrCode?: { not: null };
  qrCodeBase64?: { not: null };
  expiresAt?: { gt: Date };
}

/**
 * A `payment.findFirst` that EVALUATES the where clause the service sends,
 * rather than returning a canned row.
 *
 * This distinction is the whole point: against a canned mock, the
 * "expired PENDING row" test below would still pass even if the service
 * dropped its `expiresAt: { gt: now }` leg — the mock, not the code, would be
 * deciding the answer. Against this fake, dropping a leg fails the test.
 */
function findFirstOverRows(getRows: () => StoredPayment[]): jest.Mock {
  return jest.fn(
    async ({
      where,
      orderBy,
    }: {
      where: ReuseWhere;
      orderBy?: { createdAt: 'asc' | 'desc' };
    }) => {
      const matches = getRows().filter(
        (row) =>
          (where.participantId === undefined || row.participantId === where.participantId) &&
          (where.status === undefined || row.status === where.status) &&
          // `{ not: null }` present => the row must have a non-null value
          (where.qrCode?.not !== null || row.qrCode !== null) &&
          (where.qrCodeBase64?.not !== null || row.qrCodeBase64 !== null) &&
          (where.expiresAt?.gt === undefined ||
            (row.expiresAt !== null && row.expiresAt.getTime() > where.expiresAt.gt.getTime())),
      );

      matches.sort((a, b) =>
        orderBy?.createdAt === 'desc'
          ? b.createdAt.getTime() - a.createdAt.getTime()
          : a.createdAt.getTime() - b.createdAt.getTime(),
      );

      return matches[0] ?? null;
    },
  );
}

describe('PaymentsService', () => {
  let service: PaymentsService;
  let psp: jest.Mocked<IPaymentProvider>;
  let config: { getOrThrow: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let tx: {
    payment: { findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    participant: { update: jest.Mock; count: jest.Mock };
    challenge: { update: jest.Mock; findUnique: jest.Mock };
    invite: { updateMany: jest.Mock };
    $executeRaw: jest.Mock;
  };
  let prisma: {
    participant: { findUnique: jest.Mock; update: jest.Mock };
    payment: { create: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock };
    user: { update: jest.Mock };
    $transaction: jest.Mock;
  };

  /**
   * #1b — rows the fake `payment.findFirst` below searches. Tests push the
   * Payment rows they want to exist; empty means "no prior charge".
   */
  let paymentRows: StoredPayment[];

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
    user: { id: 'user-1', email: 'joao@example.com', name: 'João', pixKey: null, pixKeys: [] },
  };

  const webhookSecret = 'test-webhook-secret-fixture';

  /**
   * #1b fixture — the row `createCashIn` would have written for a charge that
   * is still inside its 30-minute window. Overrides let a test age it out or
   * strip its QR (the pre-migration shape).
   */
  const storedPendingPayment = (overrides: Partial<StoredPayment> = {}): StoredPayment => ({
    id: 'payment-existing',
    externalId: 'mp-external-existing',
    participantId: 'participant-1',
    status: 'PENDING',
    qrCode: '00020126...stored-copia-e-cola',
    qrCodeBase64: 'stored-base64-qr',
    ticketUrl: 'https://www.mercadopago.com/ticket/existing',
    expiresAt: new Date(Date.now() + 20 * 60_000),
    createdAt: new Date(Date.now() - 10 * 60_000),
    ...overrides,
  });

  beforeEach(async () => {
    psp = {
      createPixCharge: jest.fn().mockResolvedValue(chargeResult),
      getPayment: jest.fn(),
    };

    config = {
      getOrThrow: jest.fn().mockReturnValue(webhookSecret),
    };

    eventEmitter = { emit: jest.fn() };

    tx = {
      payment: {
        findUnique: jest.fn(),
        // Default: this participant has no other collected payment, so the
        // duplicate-collection guard is inert and every pre-existing test takes
        // the normal crediting path.
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        // Prisma always answers `{ count }`; the sibling-cancel reads it.
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
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

    // #1b: default is "no prior charge exists" — every pre-existing test
    // therefore takes the create path exactly as before.
    paymentRows = [];

    prisma = {
      participant: {
        findUnique: jest.fn().mockResolvedValue(waitingParticipant),
        update: jest.fn().mockResolvedValue({ ...waitingParticipant, pixKey: 'joao@pix' }),
      },
      payment: {
        findFirst: findFirstOverRows(() => paymentRows),
        // #4 hardening: the 404 catch asks whether WE hold a row under this
        // external id. Default "no row" preserves the ack path.
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'payment-1',
          externalId: chargeResult.externalId,
          participantId: waitingParticipant.id,
          challengeId: waitingParticipant.challengeId,
          amount: waitingParticipant.challenge.collabAmount,
          status: 'PENDING',
        }),
      },
      user: { update: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) => callback(tx)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: 'PAYMENT_PROVIDER', useValue: psp },
        { provide: EventEmitter2, useValue: eventEmitter },
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

    it('refuses with 409 when the participant already PAID — never a second charge for an entry already collected (#1a)', async () => {
      prisma.participant.findUnique.mockResolvedValueOnce({
        ...waitingParticipant,
        status: 'PAID',
        paidAt: new Date('2026-07-30T18:28:46.000Z'),
      });

      // Production repro (participant 4bf8ee39, 30/07/2026): three POSTs landed
      // AFTER the webhook marked this participant PAID and each returned 201 with
      // a brand-new MP external id. Without the guard this promise RESOLVES with
      // a fresh QR — that resolution IS the bug. V1 has no automatic refund
      // (manual cash-out, custody on the creator's account), so a duplicate
      // charge is real money lost, not an annoyance.
      await expect(service.createCashIn('participant-1')).rejects.toBeInstanceOf(ConflictException);

      expect(psp.createPixCharge).not.toHaveBeenCalled();
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('the PAID guard runs before the pixKey write — a duplicate attempt mutates nothing (#1a)', async () => {
      prisma.participant.findUnique.mockResolvedValueOnce({
        ...waitingParticipant,
        status: 'PAID',
      });

      await expect(service.createCashIn('participant-1', 'joao@pix')).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(prisma.participant.update).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('still charges a participant who has NOT paid yet (the guard is on PAID, not on every repeat call)', async () => {
      const result = await service.createCashIn('participant-1');

      expect(waitingParticipant.status).toBe('INVITED');
      expect(psp.createPixCharge).toHaveBeenCalledTimes(1);
      expect(result.paymentId).toBe('payment-1');
    });

    it('trims a pay-time pixKey before persisting it to the participant (T-i98)', async () => {
      await service.createCashIn('participant-1', '  joao@pix  ');

      expect(prisma.participant.update).toHaveBeenCalledWith({
        where: { id: 'participant-1' },
        data: { pixKey: 'joao@pix' },
      });
    });

    it('backfills the profile key (user.update, keyed on participant.userId) when the paying user has none yet (D-3/T-i98-02)', async () => {
      await service.createCashIn('participant-1', 'joao@pix');

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { pixKey: 'joao@pix', pixKeys: ['joao@pix'] },
      });
    });

    it('does NOT backfill the profile key when the paying user already has one', async () => {
      prisma.participant.findUnique.mockResolvedValueOnce({
        ...waitingParticipant,
        user: { ...waitingParticipant.user, pixKey: 'existing@pix', pixKeys: ['existing@pix'] },
      });

      await service.createCashIn('participant-1', 'new@pix');

      expect(prisma.participant.update).toHaveBeenCalledWith({
        where: { id: 'participant-1' },
        data: { pixKey: 'new@pix' },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('a whitespace-only pixKey persists nothing (neither participant nor user update)', async () => {
      await service.createCashIn('participant-1', '   ');

      expect(prisma.participant.update).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('persists the QR artifacts and the expiry on the Payment row so a later call can reuse them (#1b write path)', async () => {
      await service.createCashIn('participant-1');

      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          qrCode: chargeResult.qrCode,
          qrCodeBase64: chargeResult.qrCodeBase64,
          ticketUrl: chargeResult.ticketUrl,
          // Taken from the PSP result — the same instant sent to Mercado Pago
          // as date_of_expiration — never re-derived from Date.now() here.
          expiresAt: chargeResult.expiresAt,
        }),
      });
    });

    describe('#1b — reuse of a live PENDING cobrança', () => {
      it('pushes the full reuse predicate down to Postgres — own participant, PENDING, non-null QR, future expiry, newest first', async () => {
        await service.createCashIn('participant-1');

        // Asserted on the query and not only on the outcome: the service also
        // re-checks qrCode/expiresAt in TypeScript (Prisma types them nullable
        // regardless of the filter), and that narrowing would mask a missing
        // WHERE leg. Both layers are load-bearing, so both are pinned.
        expect(prisma.payment.findFirst).toHaveBeenCalledWith({
          where: {
            participantId: 'participant-1',
            status: 'PENDING',
            qrCode: { not: null },
            qrCodeBase64: { not: null },
            expiresAt: { gt: expect.any(Date) },
          },
          orderBy: { createdAt: 'desc' },
        });
      });

      it('returns the STORED QR and does NOT create a second Mercado Pago charge when a PENDING payment is still valid', async () => {
        const existing = storedPendingPayment();
        paymentRows.push(existing);

        const result = await service.createCashIn('participant-1');

        // The bug this closes: before #1b every screen remount reached the PSP
        // and minted another QR. Participant 4bf8ee39 ended up with four.
        expect(psp.createPixCharge).not.toHaveBeenCalled();
        expect(prisma.payment.create).not.toHaveBeenCalled();

        expect(result).toEqual({
          qrCode: existing.qrCode,
          qrCodeBase64: existing.qrCodeBase64,
          ticketUrl: existing.ticketUrl,
          expiresAt: existing.expiresAt,
          paymentId: existing.id,
        });
      });

      it('two consecutive calls (the reopen-the-screen sequence) yield ONE charge and the same paymentId', async () => {
        const first = await service.createCashIn('participant-1');

        // The row the first call would have written now exists.
        paymentRows.push(
          storedPendingPayment({
            id: first.paymentId,
            externalId: chargeResult.externalId,
            qrCode: chargeResult.qrCode,
            qrCodeBase64: chargeResult.qrCodeBase64,
            ticketUrl: chargeResult.ticketUrl,
            expiresAt: chargeResult.expiresAt,
          }),
        );
        // chargeResult's fixture expiry is a 2026 literal in the past — age it
        // forward so this row is genuinely inside its window.
        paymentRows[0].expiresAt = new Date(Date.now() + 25 * 60_000);

        const second = await service.createCashIn('participant-1');

        expect(psp.createPixCharge).toHaveBeenCalledTimes(1);
        expect(second.paymentId).toBe(first.paymentId);
        expect(second.qrCode).toBe(first.qrCode);
      });

      it('creates a NEW charge when the only PENDING payment has already expired — an unpayable QR is never handed back', async () => {
        paymentRows.push(
          storedPendingPayment({
            id: 'payment-stale',
            expiresAt: new Date(Date.now() - 60_000),
            createdAt: new Date(Date.now() - 31 * 60_000),
          }),
        );

        const result = await service.createCashIn('participant-1');

        expect(psp.createPixCharge).toHaveBeenCalledTimes(1);
        expect(prisma.payment.create).toHaveBeenCalledTimes(1);
        expect(result.paymentId).toBe('payment-1');
        expect(result.qrCode).toBe(chargeResult.qrCode);
      });

      it('creates a NEW charge for a legacy PENDING row written before the qr_code migration (qrCode = null) — no crash, no null QR', async () => {
        paymentRows.push(
          storedPendingPayment({
            id: 'payment-legacy',
            qrCode: null,
            qrCodeBase64: null,
            ticketUrl: null,
            expiresAt: null,
          }),
        );

        const result = await service.createCashIn('participant-1');

        // There is nothing to give back, so the row must fall through rather
        // than resolve with nulls or throw. Decided against a backfill: those
        // rows' QRs live only at Mercado Pago.
        expect(psp.createPixCharge).toHaveBeenCalledTimes(1);
        expect(result.qrCode).toBe(chargeResult.qrCode);
        expect(result.qrCodeBase64).toBe(chargeResult.qrCodeBase64);
      });

      it('does not reuse another participant\'s live cobrança', async () => {
        paymentRows.push(
          storedPendingPayment({ id: 'payment-someone-else', participantId: 'participant-2' }),
        );

        const result = await service.createCashIn('participant-1');

        expect(psp.createPixCharge).toHaveBeenCalledTimes(1);
        expect(result.paymentId).toBe('payment-1');
      });

      it('does not reuse a payment that already left PENDING (APPROVED / CANCELLED / REFUND_PENDING)', async () => {
        for (const status of ['APPROVED', 'CANCELLED', 'REFUND_PENDING']) {
          jest.clearAllMocks();
          paymentRows.length = 0;
          paymentRows.push(storedPendingPayment({ id: `payment-${status}`, status }));

          const result = await service.createCashIn('participant-1');

          expect(psp.createPixCharge).toHaveBeenCalledTimes(1);
          expect(result.paymentId).toBe('payment-1');
        }
      });

      it('picks the most recent reusable cobrança when production left several behind (pre-fix data)', async () => {
        paymentRows.push(
          storedPendingPayment({
            id: 'payment-older',
            qrCode: 'older-qr',
            createdAt: new Date(Date.now() - 20 * 60_000),
          }),
          storedPendingPayment({
            id: 'payment-newer',
            qrCode: 'newer-qr',
            createdAt: new Date(Date.now() - 2 * 60_000),
          }),
        );

        const result = await service.createCashIn('participant-1');

        expect(result.paymentId).toBe('payment-newer');
        expect(result.qrCode).toBe('newer-qr');
        expect(psp.createPixCharge).not.toHaveBeenCalled();
      });

      it('reuse never overrides the #1a PAID guard — an already-paid entry still gets 409, not a recycled QR', async () => {
        paymentRows.push(storedPendingPayment());
        prisma.participant.findUnique.mockResolvedValueOnce({
          ...waitingParticipant,
          status: 'PAID',
        });

        await expect(service.createCashIn('participant-1')).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(prisma.payment.findFirst).not.toHaveBeenCalled();
      });

      it('still records a pay-time pixKey on the reuse path (D-17 — the key must not be lost by reopening the screen)', async () => {
        paymentRows.push(storedPendingPayment());

        await service.createCashIn('participant-1', '  outra@chave  ');

        expect(prisma.participant.update).toHaveBeenCalledWith({
          where: { id: 'participant-1' },
          data: { pixKey: 'outra@chave' },
        });
        expect(psp.createPixCharge).not.toHaveBeenCalled();
      });

      it('falls back to an empty ticketUrl (never null) when the stored row has none', async () => {
        paymentRows.push(storedPendingPayment({ ticketUrl: null }));

        const result = await service.createCashIn('participant-1');

        expect(result.ticketUrl).toBe('');
      });

      /**
       * NIT 8 (review hardening) — "still valid" is not the same as "usable".
       *
       * `expiresAt > now` hands back a QR with seconds of life on it, and the
       * user discovers it is dead while switching to their bank app. The trap
       * has no exit either: "Gerar novo QR" POSTs again, matches the same
       * nearly-dead row, and returns it again until it finally expires.
       */
      it('does NOT reuse a cobrança about to expire — a QR with 30s left is a dead end, not a reusable charge', async () => {
        paymentRows.push(
          storedPendingPayment({
            id: 'payment-almost-dead',
            expiresAt: new Date(Date.now() + 30_000),
          }),
        );

        const result = await service.createCashIn('participant-1');

        expect(psp.createPixCharge).toHaveBeenCalledTimes(1);
        expect(result.paymentId).toBe('payment-1');
      });

      it('still reuses a cobrança with comfortable life left — the margin is a minute, not a rewrite of the reuse rule', async () => {
        paymentRows.push(
          storedPendingPayment({ id: 'payment-fresh', expiresAt: new Date(Date.now() + 5 * 60_000) }),
        );

        const result = await service.createCashIn('participant-1');

        expect(psp.createPixCharge).not.toHaveBeenCalled();
        expect(result.paymentId).toBe('payment-fresh');
      });

      it('asks Postgres for a FUTURE-dated expiry, not merely a non-expired one (the margin lives in the query)', async () => {
        await service.createCashIn('participant-1');

        const where = prisma.payment.findFirst.mock.calls[0][0].where as {
          expiresAt: { gt: Date };
        };

        // Pinned as a lower bound rather than an exact value so the constant can
        // be tuned without a false failure — but a plain `new Date()` fails it.
        expect(where.expiresAt.gt.getTime()).toBeGreaterThan(Date.now() + 30_000);
      });
    });

    it('maps a psp.createPixCharge failure to a friendly ServiceUnavailableException instead of leaking a raw 500 (GAP 3)', async () => {
      psp.createPixCharge.mockRejectedValueOnce(new Error('Unauthorized use of live credentials'));

      let caught: unknown;
      try {
        await service.createCashIn('participant-1');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ServiceUnavailableException);
      expect((caught as ServiceUnavailableException).message).toBe(
        'Não foi possível gerar a cobrança Pix agora. Tente novamente.',
      );
      expect(prisma.payment.create).not.toHaveBeenCalled();
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

    it('NOTIF-02: emits payment.confirmed once (post-commit) but NOT challenge.activated when the payment approves without reaching >=3 paid', async () => {
      psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-1' });
      tx.payment.findUnique.mockResolvedValue(existingPayment);
      tx.$executeRaw.mockResolvedValue(0); // tryActivateChallenge did not transition

      await service.handleWebhook('mp-external-id-123', {});

      expect(eventEmitter.emit).toHaveBeenCalledWith('payment.confirmed', {
        paymentId: 'payment-1',
        participantId: 'participant-1',
        challengeId: 'challenge-1',
      });
      expect(eventEmitter.emit).not.toHaveBeenCalledWith('challenge.activated', expect.anything());
    });

    it('NOTIF-02: emits BOTH payment.confirmed and challenge.activated (CALL SITE A) when the payment approval also activates the challenge', async () => {
      psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-1' });
      tx.payment.findUnique.mockResolvedValue(existingPayment);
      tx.$executeRaw.mockResolvedValue(1); // tryActivateChallenge transitioned

      await service.handleWebhook('mp-external-id-123', {});

      expect(eventEmitter.emit).toHaveBeenCalledWith('payment.confirmed', expect.objectContaining({
        paymentId: 'payment-1',
      }));
      expect(eventEmitter.emit).toHaveBeenCalledWith('challenge.activated', { challengeId: 'challenge-1' });
    });

    it('NOTIF-02: a re-delivered webhook for an already-APPROVED payment emits nothing (idempotency)', async () => {
      psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-1' });
      tx.payment.findUnique.mockResolvedValue({ ...existingPayment, status: 'APPROVED' });

      await service.handleWebhook('mp-external-id-123', {});

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('NOTIF-02: a webhook whose confirmed.status is not "approved" emits nothing', async () => {
      psp.getPayment.mockResolvedValue({ status: 'pending', externalReference: 'participant-1' });
      tx.payment.findUnique.mockResolvedValue(existingPayment);

      await service.handleWebhook('mp-external-id-123', {});

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('ROLLBACK-SAFETY (V1): if the $transaction rejects, emit is never called', async () => {
      psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-1' });
      prisma.$transaction.mockRejectedValueOnce(new Error('transaction rolled back'));

      await expect(service.handleWebhook('mp-external-id-123', {})).rejects.toThrow(
        'transaction rolled back',
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
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

    /**
     * #3 — ack vs retry.
     *
     * Mercado Pago redelivers on ANY non-200, so "does handleWebhook return or
     * throw" IS the retry decision. Both directions are tested here because
     * each failure mode is dangerous in the opposite way:
     *
     *   - acking a TRANSIENT failure loses a real payment, silently and forever
     *   - throwing on a PERMANENT 404 makes MP retry forever (what production
     *     did at 18:31:37 and 18:31:51 — the 404 became a 500)
     *
     * A blanket try/catch would fix the second by causing the first. Hence a
     * catch keyed on exactly one type.
     */
    describe('#3 — a 404 is acknowledged; every other provider failure is not', () => {
      it('PERMANENT (PaymentNotFoundError): returns normally so the controller answers 200 and MP stops retrying', async () => {
        psp.getPayment.mockRejectedValue(new PaymentNotFoundError('170356446929', 'code 2000'));

        await expect(service.handleWebhook('170356446929', {})).resolves.toEqual({
          activated: false,
        });
      });

      it('PERMANENT: writes nothing — an id the provider disowns must never move local money state', async () => {
        psp.getPayment.mockRejectedValue(new PaymentNotFoundError('170356446929', 'code 2000'));

        await service.handleWebhook('170356446929', {});

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(tx.payment.update).not.toHaveBeenCalled();
        expect(tx.participant.update).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      });

      it('TRANSIENT (5xx): THROWS, so the controller answers non-200 and Mercado Pago DOES retry', async () => {
        psp.getPayment.mockRejectedValue({ message: 'internal_error', status: 500 });

        await expect(service.handleWebhook('mp-external-id-123', {})).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
      });

      it('TRANSIENT (timeout): THROWS — a redelivery is exactly what fixes this', async () => {
        psp.getPayment.mockRejectedValue(new Error('The operation was aborted'));

        await expect(service.handleWebhook('mp-external-id-123', {})).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
      });

      it('TRANSIENT: the 503 body is generic — MP internals never reach the wire (GAP 3)', async () => {
        psp.getPayment.mockRejectedValue({
          message: 'invalid access token',
          status: 401,
          cause: [{ code: 2001, description: 'secret leak' }],
        });

        const caught = await service
          .handleWebhook('mp-external-id-123', {})
          .catch((err: unknown) => err);

        expect((caught as ServiceUnavailableException).message).toBe(
          'Não foi possível confirmar o pagamento agora.',
        );
        expect(JSON.stringify(caught)).not.toContain('secret leak');
      });

      it('TRANSIENT: nothing is written before the throw — no half-applied state on a retry', async () => {
        psp.getPayment.mockRejectedValue({ message: 'internal_error', status: 500 });

        await service.handleWebhook('mp-external-id-123', {}).catch(() => undefined);

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      });
    });

    /**
     * REVIEW HARDENING (#4) — a provider 404 is only safe to ack if we do not
     * hold a live charge under that id.
     *
     * The shipped version acked EVERY provider 404 without ever looking
     * locally, so it could not tell the safe case (an id we never issued —
     * typically another environment sharing the same Mercado Pago account) from
     * the dangerous one (a charge WE created that the provider now disowns).
     * Acking the dangerous case throws away the only recovery artifact left:
     * Mercado Pago's redelivery, which preserves the notification until the
     * fault — realistically a credential/account mismatch — is repaired.
     *
     * Both directions are pinned, because the infinite-retry loop #3 removed
     * must not come back for the genuinely-unknown id.
     */
    describe('#4 hardening — 404 for an id WE hold PENDING is not acknowledged', () => {
      const notFound = () =>
        psp.getPayment.mockRejectedValue(new PaymentNotFoundError('mp-external-id-123', 'code 2000'));

      it('THROWS (non-200) when a local PENDING row exists for the 404d external — MP keeps redelivering', async () => {
        notFound();
        prisma.payment.findUnique.mockResolvedValue({ id: 'payment-1', status: 'PENDING' });

        await expect(service.handleWebhook('mp-external-id-123', {})).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
      });

      it('writes nothing on that path — a provider that disowns our charge must not move money state', async () => {
        notFound();
        prisma.payment.findUnique.mockResolvedValue({ id: 'payment-1', status: 'PENDING' });

        await service.handleWebhook('mp-external-id-123', {}).catch(() => undefined);

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      });

      it('logs at ERROR and names the credentials as the thing to check', async () => {
        const errorSpy = jest.spyOn(service['logger'], 'error');
        notFound();
        prisma.payment.findUnique.mockResolvedValue({ id: 'payment-1', status: 'PENDING' });

        await service.handleWebhook('mp-external-id-123', {}).catch(() => undefined);

        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('MERCADOPAGO_ACCESS_TOKEN'));
      });

      it('STILL acks (200) when we hold no row at all — the #3 property survives, no infinite retry', async () => {
        notFound();
        prisma.payment.findUnique.mockResolvedValue(null);

        await expect(service.handleWebhook('mp-external-id-123', {})).resolves.toEqual({
          activated: false,
        });
      });

      it('acks a 404 for a row already APPROVED — nothing left to preserve', async () => {
        notFound();
        prisma.payment.findUnique.mockResolvedValue({ id: 'payment-1', status: 'APPROVED' });

        await expect(service.handleWebhook('mp-external-id-123', {})).resolves.toEqual({
          activated: false,
        });
      });

      it('acks a 404 for a row already CANCELLED — this is what terminates the retry loop', async () => {
        // The reconciliation sweep settles the row (or the breaker decides it
        // must not); once it is no longer PENDING a redelivery acks and the
        // retries stop. Without this the non-200 above would have no exit.
        notFound();
        prisma.payment.findUnique.mockResolvedValue({ id: 'payment-1', status: 'CANCELLED' });

        await expect(service.handleWebhook('mp-external-id-123', {})).resolves.toEqual({
          activated: false,
        });
      });
    });

    /**
     * #4 — webhook arriving before (or without) our local INSERT.
     *
     * We keep acking, because at this instant "row not committed yet" and "row
     * will never exist" are indistinguishable, and the realistic source of an
     * unknown external is a charge created against the same Mercado Pago
     * account by another environment — for which retries would never converge.
     * Recovery belongs to #2: once the row commits it sits PENDING and the
     * sweep (which now survives to completion) replays it through this method.
     *
     * So what is actually fixed here is the SILENCE. A lost `approved` and a
     * benign out-of-order `pending` used to log identically.
     */
    describe('#4 — an unknown external is acked, but an approved one is never silent', () => {
      it('logs at ERROR when the unknown external is APPROVED — money we have not credited', async () => {
        const errorSpy = jest.spyOn(service['logger'], 'error');
        psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-9' });
        tx.payment.findUnique.mockResolvedValue(null);

        await service.handleWebhook('external-never-inserted', {});

        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('external-never-inserted'),
        );
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('NOT credited'));
      });

      it('stays at WARN for the benign out-of-order pending notification (the case actually observed)', async () => {
        const errorSpy = jest.spyOn(service['logger'], 'error');
        const warnSpy = jest.spyOn(service['logger'], 'warn');
        psp.getPayment.mockResolvedValue({ status: 'pending', externalReference: 'participant-9' });
        tx.payment.findUnique.mockResolvedValue(null);

        await service.handleWebhook('170356446929', {});

        // `payment.created` landing before our INSERT commits is routine noise,
        // not an incident. Escalating it would train everyone to ignore the
        // ERROR above, which is the one that matters.
        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('170356446929'));
      });

      it('still acks (200) and still writes nothing, approved or not', async () => {
        psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-9' });
        tx.payment.findUnique.mockResolvedValue(null);

        await expect(service.handleWebhook('external-never-inserted', {})).resolves.toEqual({
          activated: false,
        });
        expect(tx.participant.update).not.toHaveBeenCalled();
        expect(tx.payment.update).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      });

      it('the #2 sweep can replay it later: once the row exists, the SAME dataId credits normally', async () => {
        psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-1' });

        // First delivery — INSERT has not committed yet.
        tx.payment.findUnique.mockResolvedValueOnce(null);
        await service.handleWebhook('mp-external-id-123', {});
        expect(tx.participant.update).not.toHaveBeenCalled();

        // Later: the row exists, and reconciliation replays the same external
        // through this very method (that is how ReconciliationJob approves).
        tx.payment.findUnique.mockResolvedValueOnce(existingPayment);
        await service.handleWebhook('mp-external-id-123', { reconciled: true });

        expect(tx.participant.update).toHaveBeenCalledWith({
          where: { id: 'participant-1' },
          data: { status: 'PAID', paidAt: expect.any(Date) },
        });
      });
    });

    /**
     * REVIEW HARDENING (#3) — an entry is collected ONCE, even when several
     * QRs for it exist.
     *
     * #1a and #1b stop new duplicates being minted, but they do nothing about
     * duplicates already outstanding — including the four live QRs participant
     * 4bf8ee39 accumulated in production on 30/07/2026. Nothing invalidated a
     * sibling when one of them was paid: the webhook for the second QR found a
     * non-APPROVED row, credited it, re-marked the participant PAID, and
     * emitted a second payment.confirmed. Money in twice; prize pool (computed
     * from the PAID participant COUNT) unchanged; the extra row in no queue.
     */
    describe('#3 — a second cobrança for the same entry never credits twice', () => {
      it('cancels the OTHER PENDING cobranças of the same participant when one is approved', async () => {
        psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-1' });
        tx.payment.findUnique.mockResolvedValue(existingPayment);
        tx.payment.updateMany.mockResolvedValue({ count: 3 });

        await service.handleWebhook('mp-external-id-123', {});

        expect(tx.payment.updateMany).toHaveBeenCalledWith({
          where: {
            participantId: 'participant-1',
            challengeId: 'challenge-1',
            status: 'PENDING',
            // Never the row being approved, and never another participant's or
            // another challenge's charge. Pinned exactly: this is a money-state
            // write, and a too-broad `where` here is worse than the bug.
            id: { not: 'payment-1' },
          },
          data: { status: 'CANCELLED' },
        });
      });

      it('says out loud that the cancelled siblings are still payable at Mercado Pago', async () => {
        const warnSpy = jest.spyOn(service['logger'], 'warn');
        psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-1' });
        tx.payment.findUnique.mockResolvedValue(existingPayment);
        tx.payment.updateMany.mockResolvedValue({ count: 3 });

        await service.handleWebhook('mp-external-id-123', {});

        // The local cancel is only half the fix; the operator has to know the
        // other half is not covered.
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('stay payable at Mercado Pago'));
      });

      it('books a SECOND collected payment as REFUND_PENDING instead of crediting it again', async () => {
        psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-1' });
        tx.payment.findUnique.mockResolvedValue({ ...existingPayment, id: 'payment-second' });
        // The entry was already collected by another payment.
        tx.payment.findFirst.mockResolvedValue({ id: 'payment-first' });

        await service.handleWebhook('mp-external-id-123', {});

        expect(tx.payment.update).toHaveBeenCalledWith({
          where: { id: 'payment-second' },
          data: {
            status: 'REFUND_PENDING',
            refundReason: 'Cobrança Pix duplicada — a entrada deste participante já havia sido paga.',
          },
        });
        // REFUND_PENDING IS the manual refund queue (D-10, AdminService), so
        // the extra money becomes an operator task instead of vanishing.
      });

      it('does NOT re-mark the participant PAID and does NOT emit a second payment.confirmed', async () => {
        psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-1' });
        tx.payment.findUnique.mockResolvedValue({ ...existingPayment, id: 'payment-second' });
        tx.payment.findFirst.mockResolvedValue({ id: 'payment-first' });

        await service.handleWebhook('mp-external-id-123', {});

        expect(tx.participant.update).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
        // And it must not activate anything off the back of a duplicate.
        expect(tx.$executeRaw).not.toHaveBeenCalled();
      });

      it('logs the duplicate collection at ERROR — money in twice is an incident, not a debug line', async () => {
        const errorSpy = jest.spyOn(service['logger'], 'error');
        psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-1' });
        tx.payment.findUnique.mockResolvedValue({ ...existingPayment, id: 'payment-second' });
        tx.payment.findFirst.mockResolvedValue({ id: 'payment-first' });

        await service.handleWebhook('mp-external-id-123', {});

        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DUPLICATE COLLECTION'));
      });

      it('counts an already-REFUND_PENDING sibling as collected too (a cancelled challenge must not reopen crediting)', async () => {
        psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-1' });
        tx.payment.findUnique.mockResolvedValue(existingPayment);

        await service.handleWebhook('mp-external-id-123', {});

        expect(tx.payment.findFirst).toHaveBeenCalledWith({
          where: {
            participantId: 'participant-1',
            status: { in: ['APPROVED', 'REFUND_PENDING'] },
            id: { not: 'payment-1' },
          },
          select: { id: true },
        });
      });

      it('the ordinary single-payment case is untouched — it credits and emits exactly as before', async () => {
        psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-1' });
        tx.payment.findUnique.mockResolvedValue(existingPayment);
        tx.payment.findFirst.mockResolvedValue(null);

        await service.handleWebhook('mp-external-id-123', {});

        expect(tx.participant.update).toHaveBeenCalledWith({
          where: { id: 'participant-1' },
          data: { status: 'PAID', paidAt: expect.any(Date) },
        });
        expect(eventEmitter.emit).toHaveBeenCalledWith(
          'payment.confirmed',
          expect.objectContaining({ paymentId: 'payment-1' }),
        );
      });
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
        data: { status: 'REFUND_PENDING', refundReason: 'Desafio cancelado pelo criador.' },
      });
    });

    it('persists the deadline default refundReason for the deadline-sweep path (item C)', async () => {
      await service.cancelChallenge('challenge-1', 'deadline');

      expect(tx.payment.updateMany).toHaveBeenCalledWith({
        where: { challengeId: 'challenge-1', status: 'APPROVED' },
        data: {
          status: 'REFUND_PENDING',
          refundReason: 'Prazo de pagamento expirou sem a turma completa.',
        },
      });
    });

    it('persists a custom refundReason verbatim when provided (item C)', async () => {
      await service.cancelChallenge('challenge-1', 'manual', 'A turma ficou com menos de 3 pessoas.');

      expect(tx.payment.updateMany).toHaveBeenCalledWith({
        where: { challengeId: 'challenge-1', status: 'APPROVED' },
        data: {
          status: 'REFUND_PENDING',
          refundReason: 'A turma ficou com menos de 3 pessoas.',
        },
      });
    });

    it('NOTIF-02: emits challenge.cancelled once, post-commit, with reason="manual" for the creator cancel path', async () => {
      await service.cancelChallenge('challenge-1', 'manual');

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith('challenge.cancelled', {
        challengeId: 'challenge-1',
        reason: 'manual',
      });
    });

    it('NOTIF-02: emits challenge.cancelled with reason="deadline" for the deadline-sweep path', async () => {
      await service.cancelChallenge('challenge-1', 'deadline');

      expect(eventEmitter.emit).toHaveBeenCalledWith('challenge.cancelled', {
        challengeId: 'challenge-1',
        reason: 'deadline',
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

    it('NOTIF-02: emits challenge.activated (CALL SITE B — the reconciliation/deadline path, distinct from handleWebhook) when >=3 paid at the deadline', async () => {
      tx.challenge.findUnique.mockResolvedValue({ id: 'challenge-1', status: 'WAITING' });
      tx.participant.count.mockResolvedValue(3);
      tx.$executeRaw.mockResolvedValue(1);

      await service.processDeadline('challenge-1');

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith('challenge.activated', { challengeId: 'challenge-1' });
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
        data: {
          status: 'REFUND_PENDING',
          refundReason: 'Prazo de pagamento expirou sem a turma completa.',
        },
      });
    });

    it('NOTIF-02: <3 paid at the deadline emits challenge.cancelled (via cancelChallenge) but never challenge.activated', async () => {
      tx.challenge.findUnique.mockResolvedValue({ id: 'challenge-1', status: 'WAITING' });
      tx.participant.count.mockResolvedValue(2);

      await service.processDeadline('challenge-1');

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith('challenge.cancelled', {
        challengeId: 'challenge-1',
        reason: 'deadline',
      });
      expect(eventEmitter.emit).not.toHaveBeenCalledWith('challenge.activated', expect.anything());
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
