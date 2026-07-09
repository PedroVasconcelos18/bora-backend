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
}
