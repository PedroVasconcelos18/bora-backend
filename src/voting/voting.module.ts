import { Module } from '@nestjs/common';
import { VotingController } from './voting.controller';
import { VotingService } from './voting.service';

/**
 * VotingModule needs no external-provider DI token (unlike PaymentsModule's
 * 'PAYMENT_PROVIDER' or StorageModule's 'OBJECT_STORAGE') — just the
 * service. VotingService is exported so the Plan 04 vote-close cron
 * (bora-backend/src/scheduler/vote-close.job.ts) can inject it to call
 * resolveEvidence.
 */
@Module({
  controllers: [VotingController],
  providers: [VotingService],
  exports: [VotingService],
})
export class VotingModule {}
