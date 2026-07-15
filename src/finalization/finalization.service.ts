import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { RankingService } from '../ranking/ranking.service';
import { saoPauloDay } from '../common/utils/sao-paulo-day.util';

const DAY_MS = 24 * 60 * 60 * 1000;

export type FinalizeResult = 'finalized' | 'already' | 'not-done';

interface WinnerShare {
  id: string;
  pixKey: string | null;
  amount: string;
}

@Injectable()
export class FinalizationService {
  private readonly logger = new Logger(FinalizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rankingService: RankingService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Idempotent auto-finalization of a "truly done" ACTIVE challenge (PAY-06).
   *
   * D-02 done-check: today (America/Sao_Paulo) must be strictly past the
   * challenge's last day AND no evidence for it may still be PENDING — this
   * honors Phase 3's D-08 exactly (late-day evidence keeps its full 24h
   * window even past challenge end), so accept/reject can never retroactively
   * flip a winner after finalization.
   *
   * D-04: winner determination reuses RankingService.getRanking() verbatim —
   * no reimplemented prize formula or leader/tie algebra.
   *
   * D-07: the prize is floored to cents per winner; the leftover remainder
   * cents go to the single deterministic first winner by participant id
   * (ascending), so sum(shares) === prize exactly and the split is
   * reproducible.
   *
   * D-03 idempotency: the status flip is an atomic conditional
   * `UPDATE ... WHERE status = 'ACTIVE'` and payout-row creation happens
   * inside the SAME `$transaction` — only the run that wins the flip creates
   * rows, mirroring PaymentsService.tryActivateChallenge/processDeadline.
   * Winners/shares are computed from reads BEFORE the transaction, but the
   * flip + all payout creates are one atomic unit so a partial crash rolls
   * back entirely.
   */
  async finalizeIfDone(challengeId: string): Promise<FinalizeResult> {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      select: { id: true, status: true, startsAt: true, durationDays: true },
    });

    if (!challenge || challenge.status !== 'ACTIVE' || !challenge.startsAt) {
      return 'not-done';
    }

    const lastDay = saoPauloDay(
      new Date(challenge.startsAt.getTime() + (challenge.durationDays - 1) * DAY_MS),
    );
    const today = saoPauloDay();

    if (!(today > lastDay)) {
      return 'not-done';
    }

    const pendingCount = await this.prisma.evidence.count({
      where: { challengeId, status: 'PENDING' },
    });
    if (pendingCount > 0) {
      return 'not-done';
    }

    // D-04: reuse — every participant tied at the max validatedDays is a
    // leader (RankingService already handles the all-zero degenerate case,
    // D-06 — every PAID participant becomes a leader).
    const ranking = await this.rankingService.getRanking(challengeId);
    const winners = ranking.participants.filter((p) => p.isLeader);
    if (winners.length === 0) {
      // No PAID participants — nothing to finalize.
      return 'not-done';
    }

    const winnerIds = winners.map((w) => w.id).sort();
    // D-2 (T-i98): the payout snapshot falls back to the winner's profile
    // key when they never set a per-challenge one.
    const pixKeyRows = await this.prisma.participant.findMany({
      where: { id: { in: winnerIds } },
      select: { id: true, pixKey: true, user: { select: { pixKey: true } } },
    });
    const pixKeyById = new Map(pixKeyRows.map((row) => [row.id, row.pixKey ?? row.user.pixKey]));

    const totalCents = Math.round(parseFloat(ranking.prize) * 100);
    const shareCents = Math.floor(totalCents / winnerIds.length);
    const remainderCents = totalCents - shareCents * winnerIds.length;

    const winnersWithShares: WinnerShare[] = winnerIds.map((id, index) => ({
      id,
      pixKey: pixKeyById.get(id) ?? null,
      amount: ((shareCents + (index === 0 ? remainderCents : 0)) / 100).toFixed(2),
    }));

    const finalized = await this.prisma.$transaction(async (tx) => {
      const rowsChanged = await tx.$executeRaw`
        UPDATE challenges SET status = 'FINISHED' WHERE id = ${challengeId} AND status = 'ACTIVE'
      `;

      if (rowsChanged !== 1) {
        // Idempotent no-op — a prior run (or a concurrent tick) already
        // finalized this challenge; never double-create payout rows.
        return false;
      }

      for (const winner of winnersWithShares) {
        await tx.payment.create({
          data: {
            participantId: winner.id,
            challengeId,
            amount: winner.amount,
            status: 'PAYOUT_PENDING',
            pixKey: winner.pixKey,
            externalId: null,
          },
        });
      }

      return true;
    });

    if (finalized) {
      // NOTIF-02 (D-02): post-commit; winnersWithShares/ranking.prize were
      // already computed from reads BEFORE the transaction, so nothing here
      // needs to be re-derived. Skipped entirely on the idempotent
      // already-finalized path (finalized === false).
      this.eventEmitter.emit('challenge.finalized', {
        challengeId,
        winnerParticipantIds: winnersWithShares.map((w) => w.id),
        prize: ranking.prize,
      });
    }

    this.logger.log(
      `finalizeIfDone: challenge ${challengeId} winners=${winnersWithShares.length} prize=${ranking.prize} finalized=${finalized}`,
    );

    return finalized ? 'finalized' : 'already';
  }

  /**
   * Caller-scoped read of the authenticated user's own payout status for a
   * challenge (T-04-13/T-04-14). Scoped strictly by `participant: { userId }`
   * — userId comes only from the verified JWT (@CurrentUser().id), never
   * from client input, so a user can only ever read their own payout row.
   * Returns null for a non-winner (no payout row exists).
   */
  async getMyPayout(
    challengeId: string,
    userId: string,
  ): Promise<{ status: 'PAYOUT_PENDING' | 'PAID_OUT'; amount: string } | null> {
    const payment = await this.prisma.payment.findFirst({
      where: {
        challengeId,
        status: { in: ['PAYOUT_PENDING', 'PAID_OUT'] },
        participant: { userId },
      },
      select: { status: true, amount: true },
    });

    if (!payment) {
      return null;
    }

    return {
      status: payment.status as 'PAYOUT_PENDING' | 'PAID_OUT',
      amount: payment.amount.toString(),
    };
  }
}
