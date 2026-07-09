import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IPaymentProvider } from './interfaces/payment-provider.interface';

export interface CashInResult {
  qrCode: string;
  qrCodeBase64: string;
  ticketUrl: string;
  expiresAt: Date;
  paymentId: string;
}

// D-08: each individual Pix cobrança (QR + copia-e-cola) expires in 30 minutes.
const PIX_EXPIRATION_MINUTES = 30;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
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

    const charge = await this.psp.createPixCharge({
      amount: Number(participant.challenge.collabAmount),
      description: `Entrada — ${participant.challenge.title}`,
      payerEmail: participant.user.email,
      externalReference: participantId,
      expirationMinutes: PIX_EXPIRATION_MINUTES,
      idempotencyKey,
    });

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
}
