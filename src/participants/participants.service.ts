import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService, CashInResult } from '../payments/payments.service';

export interface PayEntryResult extends CashInResult {
  participantId: string;
  challengeId: string;
}

export interface PaymentStatusResult {
  participantStatus: string;
  paymentStatus: string | null;
  challengeStatus: string;
}

export interface WaitingRoomParticipant {
  name: string;
  paid: boolean;
}

export interface WaitingRoomStatusResult {
  status: string;
  deadline: Date;
  paidCount: number;
  totalCount: number;
  prize: string;
  participants: WaitingRoomParticipant[];
}

// D-07: challenge payment window is 3 days from creation.
const PAYMENT_WINDOW_DAYS = 3;

@Injectable()
export class ParticipantsService {
  private readonly logger = new Logger(ParticipantsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {}

  /**
   * Creator's "pagar minha entrada" entry point (D-06).
   * Locates the caller's existing Participant row for the challenge (no invite
   * token involved — the creator has no Invite row, per Phase 1 D-11) and
   * delegates to PaymentsService.createCashIn, converging on the same charge
   * path as the invitee accept-and-pay flow.
   */
  async payEntry(
    userId: string,
    challengeId: string,
    pixKey?: string,
  ): Promise<PayEntryResult> {
    const participant = await this.prisma.participant.findUnique({
      where: { challengeId_userId: { challengeId, userId } },
    });

    if (!participant) {
      throw new NotFoundException('Você não é participante deste desafio.');
    }

    const cashIn = await this.paymentsService.createCashIn(participant.id, pixKey);

    return {
      ...cashIn,
      participantId: participant.id,
      challengeId: participant.challengeId,
    };
  }

  /**
   * Poll endpoint backing the pay screen's status query.
   * T-02-03 mitigation: only the participant's own user may read their status
   * — never keyed on a client-supplied participant id without ownership check.
   */
  async getPaymentStatus(
    participantId: string,
    userId: string,
  ): Promise<PaymentStatusResult> {
    const participant = await this.prisma.participant.findUnique({
      where: { id: participantId },
      include: { challenge: { select: { status: true } } },
    });

    if (!participant) {
      throw new NotFoundException('Participante não encontrado.');
    }

    if (participant.userId !== userId) {
      throw new ForbiddenException('Você não tem acesso a este participante.');
    }

    const latestPayment = await this.prisma.payment.findFirst({
      where: { participantId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      participantStatus: participant.status,
      paymentStatus: latestPayment?.status ?? null,
      challengeStatus: participant.challenge.status,
    };
  }

  /**
   * Waiting-room nominal list (CHAL-05, D-13): who paid and who is still
   * pending, visible to ALL participants — this is the social-pressure
   * engine, not a discreet count. Also returns the live "N de M pagaram"
   * figures, the 3-day deadline (D-07), and the prize.
   *
   * D-03 / pitfall M4: the prize is derived from the CURRENT paid count on
   * every read — never a cached column — so it can never drift from the
   * actual paid state. Clamped at 0 so a fresh challenge with zero paid
   * participants never displays a negative prize.
   */
  async getWaitingRoomStatus(challengeId: string): Promise<WaitingRoomStatusResult> {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      include: {
        participants: {
          include: { user: { select: { name: true } } },
          orderBy: { paidAt: { sort: 'asc', nulls: 'last' } },
        },
      },
    });

    if (!challenge) {
      throw new NotFoundException('Desafio não encontrado.');
    }

    const paidCount = challenge.participants.filter((p) => p.status === 'PAID').length;
    const totalCount = challenge.participants.length;

    const collabAmount = Number(challenge.collabAmount);
    const platformFee = Number(challenge.platformFee);
    const prizeValue = Math.max(0, collabAmount * paidCount - platformFee);

    const deadline = new Date(
      challenge.createdAt.getTime() + PAYMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    return {
      status: challenge.status,
      deadline,
      paidCount,
      totalCount,
      prize: prizeValue.toFixed(2),
      participants: challenge.participants.map((p) => ({
        name: p.user.name,
        paid: p.status === 'PAID',
      })),
    };
  }
}
