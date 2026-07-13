import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client.js';
import { saoPauloDay } from '../common/utils/sao-paulo-day.util';

export type VoteValue = 'SIM' | 'NAO';
export type ResolveEvidenceResult = 'accepted' | 'rejected' | 'already-resolved';

// NOTIF-02: the shape resolveEvidence's $transaction resolves to — the IDs
// the post-commit 'evidence.resolved' emit (D-02) needs, without exposing
// them through the method's public ResolveEvidenceResult return type.
interface ResolveEvidenceTxResult {
  outcome: ResolveEvidenceResult;
  participantId?: string;
  challengeId?: string;
}

export interface VotableEvidence {
  id: string;
  authorName: string;
  objectKey: string;
  windowClosesAt: Date;
  status: string;
  hasVoted: boolean;
}

@Injectable()
export class VotingService {
  private readonly logger = new Logger(VotingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Resolves the caller's own Participant row for the challenge — never a
   * client-supplied participant/voter id (T-03-08, Spoofing mitigation).
   */
  private async resolveParticipant(userId: string, challengeId: string) {
    const participant = await this.prisma.participant.findUnique({
      where: { challengeId_userId: { challengeId, userId } },
    });

    if (!participant) {
      throw new NotFoundException('Você não é participante deste desafio.');
    }

    return participant;
  }

  /**
   * Cast a Sim/Não vote on another participant's evidence (VOTE-01/04, D-06).
   * Self-vote is blocked (T-03-09); a closed window or a resolved evidence
   * is rejected with 409; re-voting surfaces the DB's P2002 unique violation
   * on [evidenceId, voterId] as a 409 rather than silently upserting — the
   * first vote is final (A4).
   */
  async castVote(userId: string, evidenceId: string, value: VoteValue): Promise<void> {
    const evidence = await this.prisma.evidence.findUnique({ where: { id: evidenceId } });
    if (!evidence) {
      throw new NotFoundException('Evidência não encontrada.');
    }

    const voter = await this.resolveParticipant(userId, evidence.challengeId);

    if (evidence.participantId === voter.id) {
      throw new ForbiddenException('Você não pode votar na sua própria evidência.');
    }

    if (evidence.status !== 'PENDING' || evidence.windowClosesAt <= new Date()) {
      throw new ConflictException('A votação dessa evidência já fechou.');
    }

    try {
      await this.prisma.vote.create({
        data: { evidenceId, voterId: voter.id, value },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Você já votou nessa evidência.');
      }
      throw err;
    }
  }

  /**
   * The votable-evidence list for today (D-04): PENDING evidences from OTHER
   * participants for the current America/Sao_Paulo day. Deliberately omits
   * sim/não tallies — only `status`/`hasVoted` are returned, never a count
   * (D-05, T-03-10, Information Disclosure mitigation).
   */
  async listVotableEvidences(userId: string, challengeId: string): Promise<VotableEvidence[]> {
    const participant = await this.resolveParticipant(userId, challengeId);
    const evidenceDate = saoPauloDay();

    const evidences = await this.prisma.evidence.findMany({
      where: {
        challengeId,
        evidenceDate,
        status: 'PENDING',
        participantId: { not: participant.id },
      },
      include: {
        participant: { include: { user: true } },
        votes: { where: { voterId: participant.id }, select: { id: true } },
      },
      orderBy: { postedAt: 'asc' },
    });

    return evidences.map((evidence) => ({
      id: evidence.id,
      authorName: evidence.participant.user.name,
      objectKey: evidence.objectKey,
      windowClosesAt: evidence.windowClosesAt,
      status: evidence.status,
      hasVoted: evidence.votes.length > 0,
    }));
  }

  /**
   * Idempotent per-evidence vote resolution (VOTE-02/03/05, Pitfall 5).
   * Mirrors PaymentsService.tryActivateChallenge's atomic-conditional-UPDATE
   * shape: re-checks `status === 'PENDING'` inside a `$transaction`, then an
   * atomic `updateMany(where status = 'PENDING')` closes the race window
   * against a second overlapping cron tick resolving the same evidence.
   *
   * eligibleVoters counts only PAID participants excluding the evidence's
   * own author (A2). Resolution formula (RESEARCH.md Vote Resolution
   * Algorithm): accepted iff eligibleVoters >= 2 * explicitNao — silence
   * (abstention) always folds toward acceptance (empate=válida, abstenção=sim).
   */
  async resolveEvidence(evidenceId: string): Promise<ResolveEvidenceResult> {
    const result = await this.prisma.$transaction(async (tx): Promise<ResolveEvidenceTxResult> => {
      const evidence = await tx.evidence.findUnique({ where: { id: evidenceId } });
      if (!evidence || evidence.status !== 'PENDING') {
        return { outcome: 'already-resolved' };
      }

      const eligibleVoters = await tx.participant.count({
        where: {
          challengeId: evidence.challengeId,
          status: 'PAID',
          id: { not: evidence.participantId },
        },
      });
      const explicitNao = await tx.vote.count({ where: { evidenceId, value: 'NAO' } });

      const newStatus = eligibleVoters >= 2 * explicitNao ? 'ACCEPTED' : 'REJECTED';

      const { count } = await tx.evidence.updateMany({
        where: { id: evidenceId, status: 'PENDING' },
        data: { status: newStatus, resolvedAt: new Date() },
      });

      if (count !== 1) {
        return { outcome: 'already-resolved' };
      }

      return {
        outcome: newStatus === 'ACCEPTED' ? 'accepted' : 'rejected',
        participantId: evidence.participantId,
        challengeId: evidence.challengeId,
      };
    });

    // NOTIF-02 (D-02): post-commit only, and only for the two outcomes that
    // actually resolved an evidence this call — 'already-resolved' (a race
    // with another overlapping cron tick, or a re-run) emits nothing.
    if (result.outcome === 'accepted' || result.outcome === 'rejected') {
      this.eventEmitter.emit('evidence.resolved', {
        evidenceId,
        participantId: result.participantId,
        challengeId: result.challengeId,
        outcome: result.outcome, // listener bifurcates tipo 4 (accepted) vs tipo 9 (rejected)
      });
    }

    this.logger.log(`resolveEvidence: evidence ${evidenceId} resolved -> ${result.outcome}`);

    return result.outcome;
  }
}
