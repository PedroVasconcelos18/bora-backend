import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

/**
 * Pure aggregate-read model over Prisma, mirroring RankingModule's shape —
 * no external-provider DI token needed.
 */
@Module({
  controllers: [ProfileController],
  providers: [ProfileService],
})
export class ProfileModule {}
