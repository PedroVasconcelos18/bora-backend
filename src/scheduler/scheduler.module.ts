import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PaymentsModule } from '../payments/payments.module';
import { ReconciliationJob } from './reconciliation.job';
import { DeadlineCancelJob } from './deadline-cancel.job';

/**
 * SchedulerModule registers the two time-driven safety nets (PAY-04, PAY-08/CHAL-06):
 *
 * - ReconciliationJob sweeps stale PENDING Payment rows whose webhook never
 *   arrived and reconciles them against Mercado Pago (D-16).
 * - DeadlineCancelJob sweeps WAITING Challenges past their 3-day payment
 *   window and auto-activates (>=3 paid) or auto-cancels into the refund
 *   queue (<3 paid) (D-02/D-07/D-09).
 *
 * PrismaService is available via the @Global() PrismaModule — no explicit
 * import needed here. PaymentsModule is imported to reach PaymentsService
 * (processDeadline, handleWebhook, tryActivateChallenge) and the
 * 'PAYMENT_PROVIDER' token both jobs need.
 */
@Module({
  imports: [ScheduleModule.forRoot(), PaymentsModule],
  providers: [ReconciliationJob, DeadlineCancelJob],
})
export class SchedulerModule {}
