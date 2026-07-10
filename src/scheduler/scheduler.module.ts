import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PaymentsModule } from '../payments/payments.module';
import { ReconciliationJob } from './reconciliation.job';
import { DeadlineCancelJob } from './deadline-cancel.job';
import { EvidenceCleanupJob } from './evidence-cleanup.job';

/**
 * SchedulerModule registers the time-driven safety nets:
 *
 * - ReconciliationJob sweeps stale PENDING Payment rows whose webhook never
 *   arrived and reconciles them against Mercado Pago (PAY-04, D-16).
 * - DeadlineCancelJob sweeps WAITING Challenges past their 3-day payment
 *   window and auto-activates (>=3 paid) or auto-cancels into the refund
 *   queue (<3 paid) (PAY-08/CHAL-06, D-02/D-07/D-09).
 * - EvidenceCleanupJob sweeps the local ephemeral evidence store and deletes
 *   photos older than 24h (V1 local-storage design pivot — the counterpart to
 *   not using Cloudflare R2).
 *
 * PrismaService is available via the @Global() PrismaModule — no explicit
 * import needed here. PaymentsModule is imported to reach PaymentsService
 * (processDeadline, handleWebhook, tryActivateChallenge) and the
 * 'PAYMENT_PROVIDER' token the payment jobs need. EvidenceCleanupJob needs
 * only ConfigService (global) to resolve the storage dir.
 */
@Module({
  imports: [ScheduleModule.forRoot(), PaymentsModule],
  providers: [ReconciliationJob, DeadlineCancelJob, EvidenceCleanupJob],
})
export class SchedulerModule {}
