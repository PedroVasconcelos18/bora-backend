import { Module } from '@nestjs/common';
import { RankingModule } from '../ranking/ranking.module';
import { FinalizationService } from './finalization.service';
import { FinalizationController } from './finalization.controller';

/**
 * FinalizationModule provides FinalizationService (PAY-06). RankingModule is
 * imported so RankingService is injectable — winner determination (D-04)
 * reuses RankingService.getRanking() verbatim, no reimplemented algebra.
 *
 * FinalizationJob itself is NOT provided here — SchedulerModule owns every
 * cron job (mirroring VoteCloseJob living in scheduler while VotingService
 * lives in its own module), so FinalizationModule only exports the service.
 *
 * FinalizationController exposes the caller-scoped GET /challenges/:id/my-payout
 * read endpoint (D-11, PAY-06 frontend half).
 */
@Module({
  imports: [RankingModule],
  controllers: [FinalizationController],
  providers: [FinalizationService],
  exports: [FinalizationService],
})
export class FinalizationModule {}
