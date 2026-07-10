import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { saoPauloDay } from '../common/utils/sao-paulo-day.util';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Streak-grid cell state (RANK-03). 'pending' is the Pitfall-2 fifth internal
 * state — a past day whose evidence is still PENDING (window not yet closed)
 * renders as pending/⏳, never falhou, until the cron actually resolves it.
 */
export type StreakCellState = 'cumprido' | 'falhou' | 'hoje' | 'futuro' | 'pending';

export interface RankingParticipant {
  id: string;
  name: string;
  validatedDays: number;
  durationDays: number;
  progress: number;
  isLeader: boolean;
  streak: StreakCellState[];
}

export interface RankingResult {
  prize: string;
  leaders: string[];
  participants: RankingParticipant[];
}

@Injectable()
export class RankingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * RANK-01/02/03/04 read model: validated-day counts, the server-computed
   * live prize, tie-aware leaders, and per-participant streak-grid cell
   * states. Only PAID participants are ranked (unpaid participants never
   * post evidence and cannot win the prize, mirroring the paidCount
   * denominator already used by getWaitingRoomStatus).
   *
   * Prize formula reuses ParticipantsService.getWaitingRoomStatus's exact
   * derivation (D-03/pitfall M4): computed live from the current PAID count
   * on every read, never cached, never accepted from the request.
   */
  async getRanking(challengeId: string): Promise<RankingResult> {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      include: {
        participants: {
          where: { status: 'PAID' },
          include: {
            user: { select: { name: true } },
            evidences: { select: { evidenceDate: true, status: true } },
          },
        },
      },
    });

    if (!challenge) {
      throw new NotFoundException('Desafio não encontrado.');
    }

    const collabAmount = Number(challenge.collabAmount);
    const platformFee = Number(challenge.platformFee);
    const paidCount = challenge.participants.length;
    const prizeValue = Math.max(0, collabAmount * paidCount - platformFee);

    const validatedCounts = await this.prisma.evidence.groupBy({
      by: ['participantId'],
      where: { challengeId, status: 'ACCEPTED' },
      _count: true,
    });
    const validatedByParticipant = new Map(
      validatedCounts.map((row) => [row.participantId, row._count]),
    );

    const durationDays = challenge.durationDays;
    // A WAITING challenge has no startsAt yet; fall back to createdAt so this
    // never throws — the frontend only mounts the ranking query once ACTIVE.
    const startsAt = challenge.startsAt ?? challenge.createdAt;
    const today = saoPauloDay();

    // Precompute the SP calendar-day string for each 1..durationDays offset
    // ONCE, shared across every participant's streak, so day boundaries can
    // never disagree between participants (Pitfall 3 — single source of truth
    // via saoPauloDay, same util the evidence-create gate uses).
    const dayStrings: string[] = [];
    for (let i = 0; i < durationDays; i++) {
      dayStrings.push(saoPauloDay(new Date(startsAt.getTime() + i * DAY_MS)));
    }

    const participants: RankingParticipant[] = challenge.participants.map((p) => {
      const evidenceStatusByDay = new Map(p.evidences.map((e) => [e.evidenceDate, e.status]));

      const streak: StreakCellState[] = dayStrings.map((day) => {
        if (day === today) return 'hoje';
        if (day > today) return 'futuro';

        // day is strictly before today (SP) — Streak Grid Derivation table:
        const status = evidenceStatusByDay.get(day);
        if (status === 'ACCEPTED') return 'cumprido';
        // Pitfall 2: a past day whose evidence is still PENDING (window not
        // yet closed) is 'pending', NOT 'falhou' — otherwise the cell would
        // flip from ✗ to ✓ after the cron resolves it, which reads as a bug.
        if (status === 'PENDING') return 'pending';
        // No evidence OR REJECTED → falhou.
        return 'falhou';
      });

      const validatedDays = validatedByParticipant.get(p.id) ?? 0;

      return {
        id: p.id,
        name: p.user.name,
        validatedDays,
        durationDays,
        progress: durationDays > 0 ? validatedDays / durationDays : 0,
        isLeader: false,
        streak,
      };
    });

    // RANK-04: every participant tied at the max validatedDays is a leader —
    // pure application-layer Math.max + filter (RESEARCH.md, no SQL window
    // function needed at this scale).
    const maxValidated = participants.reduce((max, p) => Math.max(max, p.validatedDays), 0);
    for (const participant of participants) {
      participant.isLeader = participants.length > 0 && participant.validatedDays === maxValidated;
    }
    const leaders = participants.filter((p) => p.isLeader).map((p) => p.name);

    return { prize: prizeValue.toFixed(2), leaders, participants };
  }
}
