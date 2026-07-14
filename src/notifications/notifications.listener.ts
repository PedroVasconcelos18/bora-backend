import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService, CreateNotificationInput } from './notifications.service';

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  timeZone: 'America/Sao_Paulo',
});

/**
 * `evidenceDate` is always a 'YYYY-MM-DD' America/Sao_Paulo calendar day
 * (produced by `saoPauloDay()`). Parsed at UTC noon so the SP-local weekday
 * never shifts across the date line, then formatted with the same IANA zone
 * — reuses the exact vocabulary `sao-paulo-day.util.ts` already established
 * for this string shape, without a new dependency.
 */
function weekdayLabelFor(evidenceDate: string): string {
  const [year, month, day] = evidenceDate.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return WEEKDAY_FORMATTER.format(utcNoon);
}

/**
 * The only `@OnEvent` consumer in the codebase (NOTIF-02). Interprets the 8
 * domain event names emitted by the payments/invites/evidences/voting/
 * finalization domain services and the reminder cron job into the 9
 * NotificationType rows, resolving audience (D-04) and the minimal render
 * payload the UI-SPEC contract requires per type.
 *
 * Injects NotificationsService + PrismaService only — never a domain-layer
 * provider from another module — that coupling is exactly what the event
 * bus (D-01) exists to avoid.
 *
 * No manual try/catch inside any handler: `@nestjs/event-emitter` already
 * wraps every `@OnEvent` in `wrapFunctionInTryCatchBlocks` with
 * `suppressErrors` defaulting to `true` — an error here is caught and only
 * logged by the library itself, never propagated back to the domain service
 * that emitted (D-02/D-03, T-09-06).
 */
@Injectable()
export class NotificationsListener {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * D-04 group audience: participants who actually paid (PAID or ACTIVE —
   * ParticipantStatus never adds a third post-payment state). An `INVITED`
   * participant who never paid is never fan-out audience for a group event.
   */
  private async groupAudience(
    challengeId: string,
    excludeParticipantId?: string,
  ): Promise<Array<{ id: string; userId: string }>> {
    return this.prisma.participant.findMany({
      where: {
        challengeId,
        status: { in: ['PAID', 'ACTIVE'] },
        ...(excludeParticipantId ? { id: { not: excludeParticipantId } } : {}),
      },
      select: { id: true, userId: true },
    });
  }

  /**
   * Tipo 1, INVITE_RECEIVED — pessoal. Not every `targetEmail` has a `User`
   * yet (the invitee may not have signed up) — that is the NORMAL path (the
   * invite email is the correct channel for them), not an error, so this
   * resolves via `findUnique` (never `findUniqueOrThrow`) and returns
   * silently on a miss (Pitfall 4).
   */
  @OnEvent('invite.sent')
  async handleInviteSent(payload: {
    inviteId: string;
    targetEmail: string;
    challengeId: string;
  }): Promise<void> {
    // User.email is always stored lowercased (signup/validateUser both
    // .toLowerCase() it); targetEmail is free-typed by the challenge creator,
    // so the lookup must normalize it or a mixed-case invite silently misses
    // an existing account (same bug the signup backfill below closes for the
    // no-account-yet path).
    const user = await this.prisma.user.findUnique({
      where: { email: payload.targetEmail.toLowerCase() },
    });
    if (!user) {
      return;
    }

    const challenge = await this.prisma.challenge.findUnique({
      where: { id: payload.challengeId },
      select: { title: true, collabAmount: true, creator: { select: { name: true } } },
    });
    if (!challenge) {
      return;
    }

    await this.notifications.create({
      userId: user.id,
      type: 'INVITE_RECEIVED',
      entityId: payload.inviteId,
      payload: {
        inviterName: challenge.creator.name,
        challengeTitle: challenge.title,
        amount: challenge.collabAmount.toString(),
      },
    });
  }

  /**
   * Tipo 2, PAYMENT_CONFIRMED — grupo, INCLUINDO o próprio pagador ("falta 1
   * pessoa" interessa a todos; D-04 só exclui o autor no tipo 3).
   */
  @OnEvent('payment.confirmed')
  async handlePaymentConfirmed(payload: {
    paymentId: string;
    participantId: string;
    challengeId: string;
  }): Promise<void> {
    const [challenge, payer, paidCount, audience] = await Promise.all([
      this.prisma.challenge.findUnique({ where: { id: payload.challengeId }, select: { title: true } }),
      this.prisma.participant.findUnique({
        where: { id: payload.participantId },
        select: { user: { select: { name: true } } },
      }),
      this.prisma.participant.count({
        where: { challengeId: payload.challengeId, status: { in: ['PAID', 'ACTIVE'] } },
      }),
      this.groupAudience(payload.challengeId),
    ]);

    if (!challenge || !payer) {
      return;
    }

    const missingCount = Math.max(0, 3 - paidCount); // v1.0's activation gate is >=3 paid

    const inputs: CreateNotificationInput[] = audience.map((p) => ({
      userId: p.userId,
      type: 'PAYMENT_CONFIRMED',
      entityId: payload.paymentId,
      payload: {
        payerName: payer.user.name,
        challengeTitle: challenge.title,
        challengeId: payload.challengeId,
        missingCount,
      },
    }));

    await this.notifications.createMany(inputs);
  }

  /**
   * Tipo 3, EVIDENCE_SUBMITTED — grupo MENOS o autor (D-06 explícito).
   */
  @OnEvent('evidence.submitted')
  async handleEvidenceSubmitted(payload: {
    evidenceId: string;
    participantId: string;
    challengeId: string;
  }): Promise<void> {
    const [challenge, author, audience] = await Promise.all([
      this.prisma.challenge.findUnique({ where: { id: payload.challengeId }, select: { title: true } }),
      this.prisma.participant.findUnique({
        where: { id: payload.participantId },
        select: { user: { select: { name: true } } },
      }),
      this.groupAudience(payload.challengeId, payload.participantId),
    ]);

    if (!challenge || !author) {
      return;
    }

    const inputs: CreateNotificationInput[] = audience.map((p) => ({
      userId: p.userId,
      type: 'EVIDENCE_SUBMITTED',
      entityId: payload.evidenceId,
      payload: {
        authorName: author.user.name,
        challengeTitle: challenge.title,
        challengeId: payload.challengeId,
      },
    }));

    await this.notifications.createMany(inputs);
  }

  /**
   * Tipo 4 (EVIDENCE_VALIDATED) / Tipo 9 (EVIDENCE_REJECTED) — bifurca pelo
   * `outcome`; ambos PESSOAIS (só o dono da evidência). `entityId` é o mesmo
   * `evidenceId` para os dois — o `@@unique([userId,type,entityId])` já
   * garante que nunca colidem, pois o `type` difere.
   */
  @OnEvent('evidence.resolved')
  async handleEvidenceResolved(payload: {
    evidenceId: string;
    participantId: string;
    challengeId: string;
    outcome: 'accepted' | 'rejected';
  }): Promise<void> {
    const [challenge, participant, evidence] = await Promise.all([
      this.prisma.challenge.findUnique({ where: { id: payload.challengeId }, select: { title: true } }),
      this.prisma.participant.findUnique({
        where: { id: payload.participantId },
        select: { userId: true },
      }),
      this.prisma.evidence.findUnique({
        where: { id: payload.evidenceId },
        select: { evidenceDate: true },
      }),
    ]);

    if (!challenge || !participant || !evidence) {
      return;
    }

    const basePayload = {
      challengeTitle: challenge.title,
      challengeId: payload.challengeId,
      weekdayLabel: weekdayLabelFor(evidence.evidenceDate),
    };

    if (payload.outcome === 'accepted') {
      const totalValidatedDays = await this.prisma.evidence.count({
        where: { participantId: payload.participantId, status: 'ACCEPTED' },
      });

      await this.notifications.create({
        userId: participant.userId,
        type: 'EVIDENCE_VALIDATED',
        entityId: payload.evidenceId,
        payload: { ...basePayload, totalValidatedDays },
      });
      return;
    }

    await this.notifications.create({
      userId: participant.userId,
      type: 'EVIDENCE_REJECTED',
      entityId: payload.evidenceId,
      payload: basePayload,
    });
  }

  /**
   * Tipo 5, EVIDENCE_REMINDER — pessoal. D-05: é linha de verdade na tabela
   * como qualquer outro tipo, sem estado derivado. `entityId` composto
   * (`participantId:evidenceDate`) torna o cron idempotente: rodar duas
   * vezes no mesmo dia não duplica a linha — o `@@unique` absorve.
   */
  @OnEvent('evidence.reminder')
  async handleEvidenceReminder(payload: {
    participantId: string;
    userId: string;
    challengeId: string;
    evidenceDate: string;
  }): Promise<void> {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: payload.challengeId },
      select: { title: true },
    });
    if (!challenge) {
      return;
    }

    await this.notifications.create({
      userId: payload.userId,
      type: 'EVIDENCE_REMINDER',
      entityId: `${payload.participantId}:${payload.evidenceDate}`,
      payload: {
        challengeTitle: challenge.title,
        challengeId: payload.challengeId,
      },
    });
  }

  /**
   * Tipo 6, CHALLENGE_FINALIZED — grupo. `isCurrentUserWinner` varia POR
   * DESTINATÁRIO (a UI-SPEC tem uma variante de copy pra quem venceu).
   * `winnerName` é o nome do primeiro vencedor em `winnerParticipantIds`
   * (empate: o primeiro da lista, já ordenada por id na origem do evento).
   */
  @OnEvent('challenge.finalized')
  async handleChallengeFinalized(payload: {
    challengeId: string;
    winnerParticipantIds: string[];
    prize: string;
  }): Promise<void> {
    const [challenge, firstWinner, audience] = await Promise.all([
      this.prisma.challenge.findUnique({ where: { id: payload.challengeId }, select: { title: true } }),
      this.prisma.participant.findUnique({
        where: { id: payload.winnerParticipantIds[0] },
        select: { user: { select: { name: true } } },
      }),
      this.groupAudience(payload.challengeId),
    ]);

    if (!challenge || !firstWinner) {
      return;
    }

    const winnerIds = new Set(payload.winnerParticipantIds);

    const inputs: CreateNotificationInput[] = audience.map((p) => ({
      userId: p.userId,
      type: 'CHALLENGE_FINALIZED',
      entityId: payload.challengeId,
      payload: {
        challengeTitle: challenge.title,
        challengeId: payload.challengeId,
        winnerName: firstWinner.user.name,
        isCurrentUserWinner: winnerIds.has(p.id),
        prizeAmount: payload.prize,
      },
    }));

    await this.notifications.createMany(inputs);
  }

  /** Tipo 7, CHALLENGE_CANCELLED — grupo. */
  @OnEvent('challenge.cancelled')
  async handleChallengeCancelled(payload: {
    challengeId: string;
    reason: 'manual' | 'deadline';
  }): Promise<void> {
    const [challenge, audience] = await Promise.all([
      this.prisma.challenge.findUnique({ where: { id: payload.challengeId }, select: { title: true } }),
      this.groupAudience(payload.challengeId),
    ]);

    if (!challenge) {
      return;
    }

    const inputs: CreateNotificationInput[] = audience.map((p) => ({
      userId: p.userId,
      type: 'CHALLENGE_CANCELLED',
      entityId: payload.challengeId,
      payload: {
        challengeTitle: challenge.title,
        challengeId: payload.challengeId,
        reason: payload.reason,
      },
    }));

    await this.notifications.createMany(inputs);
  }

  /** Tipo 8, CHALLENGE_ACTIVATED — grupo. */
  @OnEvent('challenge.activated')
  async handleChallengeActivated(payload: { challengeId: string }): Promise<void> {
    const [challenge, audience] = await Promise.all([
      this.prisma.challenge.findUnique({ where: { id: payload.challengeId }, select: { title: true } }),
      this.groupAudience(payload.challengeId),
    ]);

    if (!challenge) {
      return;
    }

    const inputs: CreateNotificationInput[] = audience.map((p) => ({
      userId: p.userId,
      type: 'CHALLENGE_ACTIVATED',
      entityId: payload.challengeId,
      payload: {
        challengeTitle: challenge.title,
        challengeId: payload.challengeId,
      },
    }));

    await this.notifications.createMany(inputs);
  }

  /**
   * Backfill de convites pendentes no signup (quick 260714-gl5). Fecha o
   * buraco em que `handleInviteSent` retorna em silêncio quando o convidado
   * ainda não tem conta (Pitfall 4, linha ~80): quando a conta finalmente é
   * criada, materializa aqui a `INVITE_RECEIVED` que nunca foi gravada.
   * `entityId = invite.token` — o mesmo valor que `dispatchInvites` já manda
   * como `inviteId` em `invite.sent` — para o deep-link do frontend abrir o
   * convite certo. `notifications.create` (não `createMany`) engole `P2002`
   * por linha, então rodar o backfill duas vezes para o mesmo usuário nunca
   * duplica.
   */
  @OnEvent('user.signed_up')
  async handleUserSignedUp(payload: { userId: string; email: string }): Promise<void> {
    const invites = await this.prisma.invite.findMany({
      where: {
        status: 'PENDING',
        targetEmail: { equals: payload.email, mode: 'insensitive' },
      },
      include: {
        challenge: {
          select: { title: true, collabAmount: true, creator: { select: { name: true } } },
        },
      },
    });

    const now = new Date();

    for (const invite of invites) {
      // T-GL5-01 mitigation: the query above is only a pre-filter. Postgres
      // compiles Prisma's `mode: 'insensitive'` to ILIKE, where `_` and `%`
      // are wildcards — a targetEmail of 'joaoXdoe@x.com' would match a
      // signup of 'joao_doe@x.com' and leak that invite's challenge title,
      // creator name, and TOKEN to the wrong account. Re-check the match in
      // JS with a plain string comparison before ever creating a
      // notification.
      if (invite.targetEmail.toLowerCase() !== payload.email.toLowerCase()) {
        continue;
      }

      // expiresAt: null means no expiration — do NOT skip it.
      if (invite.expiresAt !== null && invite.expiresAt <= now) {
        continue;
      }

      await this.notifications.create({
        userId: payload.userId,
        type: 'INVITE_RECEIVED',
        entityId: invite.token,
        payload: {
          inviterName: invite.challenge.creator.name,
          challengeTitle: invite.challenge.title,
          amount: invite.challenge.collabAmount.toString(),
        },
      });
    }
  }
}
