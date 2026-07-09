import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface RefundQueueRow {
  id: string;
  challengeTitle: string;
  participantName: string;
  amount: string;
  pixKey: string | null;
}

export interface MarkRefundedResult {
  id: string;
  status: string;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /admin/refunds — the manual refund queue (D-10). A Payment row with
   * status REFUND_PENDING IS a queue entry; this just shapes it for the
   * operator: participant name, amount (Decimal -> string, mirrors the
   * codebase's established shaping pattern), and Pix key (D-17, captured at
   * pay time on the paying Participant).
   */
  async listRefunds(): Promise<RefundQueueRow[]> {
    const payments = await this.prisma.payment.findMany({
      where: { status: 'REFUND_PENDING' },
      include: {
        challenge: { select: { title: true } },
        participant: { select: { pixKey: true, user: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return payments.map((payment) => ({
      id: payment.id,
      challengeTitle: payment.challenge.title,
      participantName: payment.participant.user.name,
      amount: payment.amount.toString(),
      pixKey: payment.participant.pixKey,
    }));
  }

  /**
   * PATCH /admin/refunds/:id — the operator marks a manual Pix refund as
   * done (D-10). Sets status REFUNDED, stamps refundedAt, and logs the
   * action (T-02-23 — untracked refund marking is a repudiation risk).
   */
  async markRefunded(paymentId: string): Promise<MarkRefundedResult> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });

    if (!payment) {
      throw new NotFoundException('Pagamento não encontrado.');
    }

    if (payment.status !== 'REFUND_PENDING') {
      throw new ConflictException('Este pagamento não está na fila de reembolso.');
    }

    const updated = await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'REFUNDED', refundedAt: new Date() },
    });

    this.logger.log(`admin refund marked done payment=${paymentId}`);

    return { id: updated.id, status: updated.status };
  }
}
