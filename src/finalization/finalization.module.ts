import { Module } from '@nestjs/common';
import { RankingModule } from '../ranking/ranking.module';
import { FinalizationService } from './finalization.service';

/**
 * FinalizationModule provides FinalizationService (PAY-06). RankingModule is
 * imported so RankingService is injectable — winner determination (D-04)
 * reuses RankingService.getRanking() verbatim, no reimplemented algebra.
 *
 * FinalizationJob itself is NOT provided here — SchedulerModule owns every
 * cron job (mirroring VoteCloseJob living in scheduler while VotingService
 * lives in its own module), so FinalizationModule only exports the service.
 */
@Module({
  imports: [RankingModule],
  providers: [FinalizationService],
  exports: [FinalizationService],
})
export class FinalizationModule {}
