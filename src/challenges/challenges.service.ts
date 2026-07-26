import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InvitesService, InviteWithLink } from '../invites/invites.service';
import { PaymentsService } from '../payments/payments.service';
import { CreateChallengeDto } from './dto/create-challenge.dto';
import { saoPauloStartOfDay } from '../common/utils/sao-paulo-day.util';

export interface ChallengeWithLinks {
  id: string;
  title: string;
  emoji: string;
  durationDays: number;
  collabAmount: string;
  platformFee: string;
  status: string;
  creatorId: string;
  createdAt: Date;
  startsAt: Date | null;
  copyableLinks: InviteWithLink[];
}

@Injectable()
export class ChallengesService {
  private readonly logger = new Logger(ChallengesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invitesService: InvitesService,
    private readonly paymentsService: PaymentsService,
  ) {}

  /**
   * Create a challenge in WAITING status:
   * 1. In a single $transaction: persist Challenge, creator Participant (INVITED, paidAt null), and Invite rows.
   * 2. Dispatch invite emails via InvitesService (outside the transaction — email failure must not roll back DB writes).
   * 3. Return the challenge + copyable invite links.
   *
   * D-11: Creator is NOT marked as paid. No ACTIVE status. No payment code.
   */
  async create(
    dto: CreateChallengeDto,
    creatorId: string,
  ): Promise<ChallengeWithLinks> {
    // Run DB writes in a single transaction
    const { challenge, inviteTokens } = await this.prisma.$transaction(
      async (tx) => {
        // 1. Create challenge in WAITING. `startsAt` guarda a data de início
        // planejada (feedback): a ativação automática (>=3 pagos) só dispara a
        // partir dela; sem data escolhida fica null e o desafio começa assim
        // que a turma paga (comportamento antigo).
        //
        // saoPauloStartOfDay (não `new Date(dto.startDate)`): a string vem como
        // 'YYYY-MM-DD' e o construtor a interpreta como meia-noite UTC, que em
        // SP é 21:00 da VÉSPERA. Com isso o dia 1 do ranking caía um dia antes
        // do início escolhido — dia em que ninguém podia postar, logo `falhou`
        // pra turma inteira. Persistindo o instante certo, ranking, gate de
        // ativação (payments.service) e deadline-cancel.job passam a concordar.
        const challenge = await tx.challenge.create({
          data: {
            title: dto.title,
            emoji: dto.emoji,
            durationDays: dto.durationDays,
            collabAmount: dto.collabAmount,
            platformFee: 10,
            status: 'WAITING',
            creatorId,
            startsAt: dto.startDate ? saoPauloStartOfDay(dto.startDate) : null,
          },
        });

        // 2. Create creator Participant (INVITED, paidAt null — D-11 zero money)
        await tx.participant.create({
          data: {
            challengeId: challenge.id,
            userId: creatorId,
            status: 'INVITED',
            paidAt: null,
          },
        });

        // 3. Create one Invite per invitee email
        const inviteTokens: Array<{ token: string; targetEmail: string }> = [];
        for (const email of dto.invitees) {
          const invite = await tx.invite.create({
            data: {
              challengeId: challenge.id,
              targetEmail: email.toLowerCase().trim(),
              status: 'PENDING',
            },
          });
          inviteTokens.push({ token: invite.token, targetEmail: invite.targetEmail });
        }

        return { challenge, inviteTokens };
      },
    );

    // Dispatch invite emails outside the transaction (email failure must not roll back)
    const copyableLinks = await this.invitesService.dispatchInvites(
      challenge.id,
      challenge.title,
      challenge.emoji,
      inviteTokens,
    );

    return {
      id: challenge.id,
      title: challenge.title,
      emoji: challenge.emoji,
      durationDays: challenge.durationDays,
      collabAmount: challenge.collabAmount.toString(),
      platformFee: challenge.platformFee.toString(),
      status: challenge.status,
      creatorId: challenge.creatorId,
      createdAt: challenge.createdAt,
      startsAt: challenge.startsAt,
      copyableLinks,
    };
  }

  /**
   * List all challenges where the caller is the creator OR a participant
   * (invited/joined). This is the "Seus desafios" home feed — non-creator
   * participants must be able to reach challenges they paid into, not just
   * ones they created.
   */
  async list(creatorId: string) {
    const challenges = await this.prisma.challenge.findMany({
      where: {
        OR: [
          { creatorId },
          { participants: { some: { userId: creatorId } } },
        ],
      },
      include: {
        participants: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
        invites: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return challenges.map((c) => ({
      ...c,
      collabAmount: c.collabAmount.toString(),
      platformFee: c.platformFee.toString(),
    }));
  }

  /**
   * Get a single challenge by ID (with participants + invites).
   */
  async get(id: string) {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id },
      include: {
        participants: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
        invites: true,
      },
    });

    if (!challenge) return null;

    return {
      ...challenge,
      collabAmount: challenge.collabAmount.toString(),
      platformFee: challenge.platformFee.toString(),
    };
  }

  /**
   * Creator-initiated cancellation (PAY-08 manual path, D-09).
   * Guards: caller must be the challenge's creator (T-02-12) and the
   * challenge must still be WAITING — once ACTIVE, participation is a
   * commitment and there is no cancellation (T-02-13, no refund after start).
   * Delegates the actual state transition + refund-queue enqueue to
   * PaymentsService.cancelChallenge (D-09/D-10/D-12, single $transaction).
   */
  async cancel(challengeId: string, callerId: string): Promise<{ status: string }> {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
    });

    if (!challenge) {
      throw new NotFoundException('Desafio não encontrado.');
    }

    if (challenge.creatorId !== callerId) {
      throw new ForbiddenException('Apenas o criador pode cancelar o desafio.');
    }

    if (challenge.status !== 'WAITING') {
      throw new ConflictException(
        'Só é possível cancelar um desafio enquanto ele está aguardando turma.',
      );
    }

    await this.paymentsService.cancelChallenge(challengeId, 'manual');

    return { status: 'CANCELLED' };
  }

  /**
   * Creator-initiated "começar agora" (feedback): start the challenge before
   * its planned start date once the group is fully settled — only the payers
   * remain (invited-but-not-accepted removed) and everyone in has paid.
   *
   * Guards: caller is the creator, challenge is still WAITING, no PENDING
   * invites remain, at least 2 participants, and every participant is PAID.
   * The atomic transition (and the same set of pré-conditions re-checked
   * inside a $transaction against races) lives in
   * PaymentsService.startNowActivate — this method produces the friendly
   * pt-BR errors and delegates the state change.
   */
  async startNow(challengeId: string, callerId: string): Promise<{ status: string }> {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
    });

    if (!challenge) {
      throw new NotFoundException('Desafio não encontrado.');
    }

    if (challenge.creatorId !== callerId) {
      throw new ForbiddenException('Apenas o criador pode iniciar o desafio.');
    }

    if (challenge.status !== 'WAITING') {
      throw new ConflictException(
        'Este desafio já começou ou não está mais aguardando turma.',
      );
    }

    const pendingInvites = await this.prisma.invite.count({
      where: { challengeId, status: 'PENDING' },
    });
    if (pendingInvites > 0) {
      throw new ConflictException(
        'Ainda há convidados que não aceitaram. Remova-os ou espere aceitarem antes de começar.',
      );
    }

    const participants = await this.prisma.participant.findMany({
      where: { challengeId },
      select: { status: true },
    });
    const everyonePaid =
      participants.length >= 2 && participants.every((p) => p.status === 'PAID');
    if (!everyonePaid) {
      throw new ConflictException(
        'Todo mundo precisa ter pago para começar o desafio agora.',
      );
    }

    const { started } = await this.paymentsService.startNowActivate(challengeId);
    if (!started) {
      throw new ConflictException(
        'Não foi possível iniciar o desafio agora. Atualize a página e tente de novo.',
      );
    }

    return { status: 'ACTIVE' };
  }

  /**
   * Creator removes an accepted-but-unpaid participant while the challenge is
   * still WAITING (item B, decisão travada 1). Guards:
   * - only the creator (T-otp-01);
   * - only in WAITING (participação vira compromisso após ACTIVE);
   * - the participant must belong to this challenge (T-otp-02);
   * - never the creator's own row, never someone who already paid (409).
   *
   * On success: deletes the participant's non-APPROVED payments (avoids FK
   * violation), deletes the Participant, and EXPIRES the matching ACCEPTED
   * invite. If the roster drops below 3, the challenge is cancelled and any
   * APPROVED payment moves to REFUND_PENDING with a legible motive (reuses
   * PaymentsService.cancelChallenge).
   */
  async removeParticipant(
    challengeId: string,
    participantId: string,
    callerId: string,
  ): Promise<{ removed: true; challengeCancelled: boolean; remainingParticipants: number }> {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
    });

    if (!challenge) {
      throw new NotFoundException('Desafio não encontrado.');
    }

    if (challenge.creatorId !== callerId) {
      throw new ForbiddenException('Apenas o criador pode remover participantes.');
    }

    if (challenge.status !== 'WAITING') {
      throw new ConflictException(
        'Só é possível remover participantes enquanto o desafio está aguardando turma.',
      );
    }

    const participant = await this.prisma.participant.findUnique({
      where: { id: participantId },
      include: { user: true, payments: true },
    });

    if (!participant || participant.challengeId !== challengeId) {
      throw new NotFoundException('Participante não encontrado neste desafio.');
    }

    if (participant.userId === challenge.creatorId) {
      throw new ConflictException('O criador não pode se remover do desafio.');
    }

    const hasApprovedPayment = participant.payments.some((p) => p.status === 'APPROVED');
    if (participant.status === 'PAID' || hasApprovedPayment) {
      throw new ConflictException('Não é possível remover quem já pagou.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.deleteMany({
        where: { participantId, status: { not: 'APPROVED' } },
      });

      await tx.participant.delete({ where: { id: participantId } });

      await tx.invite.updateMany({
        where: {
          challengeId,
          targetEmail: participant.user.email.toLowerCase(),
          status: 'ACCEPTED',
        },
        data: { status: 'EXPIRED' },
      });
    });

    const remainingParticipants = await this.prisma.participant.count({
      where: { challengeId },
    });

    if (remainingParticipants < 3) {
      await this.paymentsService.cancelChallenge(
        challengeId,
        'manual',
        'A turma ficou com menos de 3 pessoas após a remoção de um participante.',
      );
      return { removed: true, challengeCancelled: true, remainingParticipants };
    }

    return { removed: true, challengeCancelled: false, remainingParticipants };
  }
}
