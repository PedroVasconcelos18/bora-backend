import { Module } from '@nestjs/common';
import { RankingController } from './ranking.controller';
import { RankingService } from './ranking.service';

/**
 * No external-provider DI token needed (unlike PaymentsModule's
 * 'PAYMENT_PROVIDER' or StorageModule's 'OBJECT_STORAGE') — RankingService is
 * a pure aggregate-read model over Prisma, mirroring VotingModule's shape.
 */
@Module({
  controllers: [RankingController],
  providers: [RankingService],
  exports: [RankingService],
})
export class RankingModule {}
