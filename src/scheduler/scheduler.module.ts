import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PaymentsModule } from '../payments/payments.module';
import { VotingModule } from '../voting/voting.module';
import { FinalizationModule } from '../finalization/finalization.module';
import { ReconciliationJob } from './reconciliation.job';
import { DeadlineCancelJob } from './deadline-cancel.job';
import { EvidenceCleanupJob } from './evidence-cleanup.job';
import { VoteCloseJob } from './vote-close.job';
import { FinalizationJob } from '../finalization/finalization.job';
import { EvidenceReminderJob } from './evidence-reminder.job';

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
 * - VoteCloseJob sweeps PENDING Evidence rows past their 24h vote window and
 *   delegates each to VotingService.resolveEvidence (VOTE-05).
 * - FinalizationJob sweeps ACTIVE Challenges every 15 min (SP-anchored) and
 *   delegates each to FinalizationService.finalizeIfDone, which determines
 *   winners (reusing RankingService), splits the prize to the exact centavo,
 *   and idempotently records one PAYOUT_PENDING cash-out row per winner
 *   (PAY-06, D-01/D-02/D-03).
 * - EvidenceReminderJob (NOTIF-02, D-07) sweeps daily at 18h SP for PAID/
 *   ACTIVE participants of ACTIVE challenges who haven't posted an evidence
 *   yet today, and emits one 'evidence.reminder' event per participant — the
 *   5th cron, and the only temporal notification type (tipo 5). No
 *   notification logic lives in the job itself; it only finds candidates and
 *   emits.
 *
 * PrismaService is available via the @Global() PrismaModule — no explicit
 * import needed here. PaymentsModule is imported to reach PaymentsService
 * (processDeadline, handleWebhook, tryActivateChallenge) and the
 * 'PAYMENT_PROVIDER' token the payment jobs need. EvidenceCleanupJob needs
 * only ConfigService (global) to resolve the storage dir. VotingModule is
 * imported so VotingService is injectable into VoteCloseJob. FinalizationModule
 * is imported so FinalizationService (and transitively RankingService) is
 * injectable into FinalizationJob. EvidenceReminderJob needs only
 * PrismaService (global) and EventEmitter2 (global via EventEmitterModule.
 * forRoot() in AppModule) — no additional import required.
 */
@Module({
  imports: [ScheduleModule.forRoot(), PaymentsModule, VotingModule, FinalizationModule],
  providers: [
    ReconciliationJob,
    DeadlineCancelJob,
    EvidenceCleanupJob,
    VoteCloseJob,
    FinalizationJob,
    EvidenceReminderJob,
  ],
})
export class SchedulerModule {}
