import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service';
import { IPaymentProvider, PixChargeResult } from './interfaces/payment-provider.interface';
import { verifyMpSignature } from './utils/verify-signature.util';

export interface CashInResult {
  qrCode: string;
  qrCodeBase64: string;
  ticketUrl: string;
  expiresAt: Date;
  paymentId: string;
}

export interface HandleWebhookResult {
  activated: boolean;
}

export interface DeadlineResult {
  action: 'none' | 'activated' | 'cancelled';
}

// D-08: each individual Pix cobrança (QR + copia-e-cola) expires in 30 minutes.
const PIX_EXPIRATION_MINUTES = 30;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject('PAYMENT_PROVIDER') private readonly psp: IPaymentProvider,
  ) {}

  /**
   * Create a Pix cash-in charge for a participant's challenge collaboration.
   *
   * Both the invitee accept-and-pay flow and the creator's "pagar minha
   * entrada" flow converge on this method (D-06). Charges are only accepted
   * while the challenge is WAITING (pitfall M4 — the prize pool is computed
   * from the paid count, which must be locked once the challenge activates).
   */
  async createCashIn(participantId: string, pixKey?: string): Promise<CashInResult> {
    const participant = await this.prisma.participant.findUnique({
      where: { id: participantId },
      include: { challenge: true, user: true },
    });

    if (!participant) {
      throw new NotFoundException('Participante não encontrado.');
    }

    if (participant.challenge.status !== 'WAITING') {
      throw new BadRequestException(
        'Cobranças Pix só podem ser criadas enquanto o desafio está aguardando turma.',
      );
    }

    // D-17: capture the Pix key at pay time for the eventual refund queue.
    if (pixKey) {
      await this.prisma.participant.update({
        where: { id: participantId },
        data: { pixKey },
      });
    }

    // D-15: always send an idempotency key on charge creation.
    const idempotencyKey = `${participantId}-${Date.now()}`;

    let charge: PixChargeResult;
    try {
      charge = await this.psp.createPixCharge({
        amount: Number(participant.challenge.collabAmount),
        description: `Entrada — ${participant.challenge.title}`,
        payerEmail: participant.user.email,
        externalReference: participantId,
        expirationMinutes: PIX_EXPIRATION_MINUTES,
        idempotencyKey,
      });
    } catch (err) {
      // GAP 3 / T-02-G3: MP internals (401/400 bodies, stack) never leave the
      // process — the client only ever sees a generic pt-BR 503.
      this.logger.error(
        `createCashIn: psp.createPixCharge failed for participant ${participantId}: ${
          err instanceof Error ? err.stack ?? err.message : String(err)
        }`,
      );
      throw new ServiceUnavailableException(
        'Não foi possível gerar a cobrança Pix agora. Tente novamente.',
      );
    }

    const payment = await this.prisma.payment.create({
      data: {
        externalId: charge.externalId,
        participantId,
        challengeId: participant.challengeId,
        amount: participant.challenge.collabAmount,
        status: 'PENDING',
      },
    });

    this.logger.log(
      `createCashIn: created PENDING payment ${payment.id} (external=${charge.externalId}) for participant ${participantId}`,
    );

    return {
      qrCode: charge.qrCode,
      qrCodeBase64: charge.qrCodeBase64,
      ticketUrl: charge.ticketUrl,
      expiresAt: charge.expiresAt,
      paymentId: payment.id,
    };
  }

  /**
   * Verify the Mercado Pago `x-signature` webhook header (PAY-03, D-15).
   * Delegates to the pure HMAC util, sourcing the secret via ConfigService.
   * `getOrThrow` means a missing MERCADOPAGO_WEBHOOK_SECRET fails loudly at
   * call time rather than silently accepting every webhook.
   */
  verifySignature(xSignature: string | undefined, xRequestId: string | undefined, dataId: string): boolean {
    const secret = this.config.getOrThrow<string>('MERCADOPAGO_WEBHOOK_SECRET');
    return verifyMpSignature({ xSignature, xRequestId, dataId, secret });
  }

  /**
   * Idempotent, verify-via-API webhook handler (PAY-02, D-15, T-02-07/08/11).
   *
   * The webhook body is NEVER trusted for state changes — `psp.getPayment`
   * (GET /v1/payments/{id}) is called before any Prisma write. Idempotency
   * is enforced by looking up the `Payment` row by its `@unique externalId`
   * inside a single `$transaction`: an already-APPROVED row is a no-op
   * (safe against MP's webhook retries / double delivery). A dataId with no
   * matching Payment row is logged and ignored — it never fabricates a
   * participant or payment.
   */
  async handleWebhook(dataId: string, rawBody: unknown): Promise<HandleWebhookResult> {
    const confirmed = await this.psp.getPayment(dataId);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.payment.findUnique({ where: { externalId: dataId } });

      if (!existing) {
        this.logger.warn(
          `handleWebhook: no Payment row found for externalId=${dataId} — ignoring webhook`,
        );
        return { activated: false };
      }

      if (existing.status === 'APPROVED') {
        // Idempotent no-op — this webhook (or a re-delivery of it) was already processed.
        this.logger.log(
          `handleWebhook: payment ${existing.id} (externalId=${dataId}) already APPROVED — idempotent no-op`,
        );
        return { activated: false };
      }

      await tx.payment.update({
        where: { id: existing.id },
        data: { rawWebhookPayload: (rawBody ?? {}) as Prisma.InputJsonValue },
      });

      if (confirmed.status !== 'approved') {
        this.logger.log(
          `handleWebhook: payment ${existing.id} (externalId=${dataId}) confirmed status=${confirmed.status} — not yet approved`,
        );
        return { activated: false };
      }

      await tx.payment.update({
        where: { id: existing.id },
        data: { status: 'APPROVED', paidAt: new Date() },
      });

      await tx.participant.update({
        where: { id: existing.participantId },
        data: { status: 'PAID', paidAt: new Date() },
      });

      const activated = await this.tryActivateChallenge(tx, existing.challengeId);

      this.logger.log(
        `handleWebhook: participant ${existing.participantId} marked PAID (payment ${existing.id})${
          activated ? ' — challenge activated' : ''
        }`,
      );

      return { activated };
    });
  }

  /**
   * Atomic conditional challenge activation (CHAL-06, D-04, pitfall S2).
   *
   * A single `$executeRaw` `UPDATE ... WHERE status = 'WAITING' AND (paid
   * count) >= 3` — never a read-then-write. Two concurrent payments racing
   * this serialize on the row's implicit lock; only one call observes
   * `status = 'WAITING'` still true and performs the transition, so the
   * returned boolean tells the caller whether THIS call was the one that
   * activated the challenge (useful for firing "challenge started" side
   * effects exactly once).
   */
  async tryActivateChallenge(tx: Prisma.TransactionClient, challengeId: string): Promise<boolean> {
    const rowsChanged = await tx.$executeRaw`
      UPDATE challenges
      SET status = 'ACTIVE', starts_at = NOW()
      WHERE id = ${challengeId}
        AND status = 'WAITING'
        AND (
          SELECT COUNT(*) FROM participants
          WHERE challenge_id = ${challengeId} AND status = 'PAID'
        ) >= 3
    `;

    if (rowsChanged === 1) {
      this.logger.log(`tryActivateChallenge: challenge ${challengeId} transitioned WAITING -> ACTIVE`);
    }

    return rowsChanged === 1;
  }

  /**
   * Cancellation → refund queue → invite expiry, chained atomically (D-09/D-10/D-12).
   *
   * In a single `$transaction`: flips the challenge to CANCELLED, expires its
   * pending invites (D-12 — forwarded/old links stop working), and moves any
   * already-APPROVED payment for the challenge to REFUND_PENDING — that row
   * set IS the manual refund queue an admin works from (D-10). Callers
   * (creator cancel endpoint, and later the deadline-sweep cron) both funnel
   * through this single method so the three consequences never drift apart.
   */
  async cancelChallenge(challengeId: string, reason: 'manual' | 'deadline'): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.challenge.update({
        where: { id: challengeId },
        data: { status: 'CANCELLED' },
      });

      await tx.invite.updateMany({
        where: { challengeId, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });

      await tx.payment.updateMany({
        where: { challengeId, status: 'APPROVED' },
        data: { status: 'REFUND_PENDING' },
      });
    });

    this.logger.log(
      `cancelChallenge: challenge ${challengeId} CANCELLED (reason=${reason}); pending invites EXPIRED; approved payments -> REFUND_PENDING`,
    );
  }

  /**
   * Resolve an expired WAITING challenge at its 3-day payment deadline
   * (D-02/D-07/D-09, PAY-08 auto path, CHAL-06 deadline path).
   *
   * Idempotent: if the challenge is no longer WAITING (already ACTIVE,
   * CANCELLED, or FINISHED), this is a no-op — safe to call twice for the
   * same challenge (e.g. a slow cron run overlapping the next tick).
   *
   * >= 3 paid participants: reuses the exact same atomic conditional UPDATE
   * as the webhook path (tryActivateChallenge) — no separate activation
   * logic to drift out of sync (pitfall S2).
   * < 3 paid participants: funnels through cancelChallenge('deadline') —
   * the same single-$transaction CANCELLED + EXPIRED invites + REFUND_PENDING
   * chain the creator's manual cancel endpoint uses (D-09/D-10/D-12).
   */
  async processDeadline(challengeId: string): Promise<DeadlineResult> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const challenge = await tx.challenge.findUnique({ where: { id: challengeId } });

      if (!challenge) {
        throw new NotFoundException('Desafio não encontrado.');
      }

      if (challenge.status !== 'WAITING') {
        // Idempotent no-op — already resolved by a prior run or the webhook path.
        return { action: 'none' as const };
      }

      const paidCount = await tx.participant.count({
        where: { challengeId, status: 'PAID' },
      });

      if (paidCount >= 3) {
        const activated = await this.tryActivateChallenge(tx, challengeId);
        return { action: (activated ? 'activated' : 'none') as 'activated' | 'none' };
      }

      return { action: 'cancel' as const };
    });

    if (outcome.action === 'cancel') {
      await this.cancelChallenge(challengeId, 'deadline');
      this.logger.log(
        `processDeadline: challenge ${challengeId} <3 paid at deadline — cancelled into refund queue`,
      );
      return { action: 'cancelled' };
    }

    if (outcome.action === 'activated') {
      this.logger.log(`processDeadline: challenge ${challengeId} >=3 paid at deadline — activated`);
    }

    return outcome;
  }
}
