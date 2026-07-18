import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';

// D-07: the challenge payment window is 3 days from creation.
const PAYMENT_WINDOW_DAYS = 3;

/**
 * Deadline-cancel cron (D-02/D-07/D-09, PAY-08 auto path, CHAL-06 deadline path).
 *
 * Sweeps `Challenge` rows still WAITING past their 3-day payment window and
 * delegates each one to `PaymentsService.processDeadline`, which atomically
 * either activates (>=3 paid, reusing the same conditional UPDATE the
 * webhook path uses) or cancels into the refund queue (<3 paid, via
 * `cancelChallenge('deadline')`). No duplicated activation/cancellation
 * logic lives here — this job only finds candidates and counts outcomes.
 *
 * Idempotent: `processDeadline` no-ops once a challenge is no longer
 * WAITING, and the `where: { status: 'WAITING' }` query here stops
 * returning a challenge the moment it resolves — running this job twice in
 * a row (or twice concurrently) produces the same end state.
 */
@Injectable()
export class DeadlineCancelJob {
  private readonly logger = new Logger(DeadlineCancelJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {}

  @Cron('*/15 * * * *', { timeZone: 'America/Sao_Paulo' }) // every 15 min, timezone-aware
  async run(): Promise<void> {
    const cutoff = new Date(Date.now() - PAYMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const expired = await this.prisma.challenge.findMany({
      where: { status: 'WAITING', createdAt: { lt: cutoff } },
      select: { id: true },
    });

    let activated = 0;
    let cancelled = 0;

    for (const challenge of expired) {
      const result = await this.paymentsService.processDeadline(challenge.id);
      if (result.action === 'activated') activated++;
      if (result.action === 'cancelled') cancelled++;
    }

    // Data de início planejada (feedback): desafios cuja `starts_at` já chegou
    // e que têm turma paga (>=3) precisam ativar mesmo antes da janela de 3
    // dias fechar — o sweep acima só pega os expirados. `activateIfDue` reusa o
    // mesmo UPDATE condicional (idempotente; no-op se <3 pagos ou já ativo).
    const due = await this.prisma.challenge.findMany({
      where: { status: 'WAITING', startsAt: { lte: new Date() } },
      select: { id: true },
    });

    for (const challenge of due) {
      const result = await this.paymentsService.activateIfDue(challenge.id);
      if (result.action === 'activated') activated++;
    }

    this.logger.log(
      `deadline-cancel: expired=${expired.length} due=${due.length} activated=${activated} cancelled=${cancelled} at=${new Date().toISOString()}`,
    );
  }
}
