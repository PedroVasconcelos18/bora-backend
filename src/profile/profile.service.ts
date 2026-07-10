import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ProfileStats {
  activeChallenges: number;
  validatedDays: number;
}

/**
 * PROF-01 aggregate-read model, mirroring RankingService's aggregate-read
 * shape over Prisma (no writes, no caching — always computed live).
 */
@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Both counts are scoped strictly to `userId` (D-12) — never accept a user
   * id from the caller; this always comes from `@CurrentUser().id` upstream.
   */
  async getStats(userId: string): Promise<ProfileStats> {
    const activeChallenges = await this.prisma.participant.count({
      where: { userId, status: 'PAID', challenge: { status: 'ACTIVE' } },
    });
    const validatedDays = await this.prisma.evidence.count({
      where: { participant: { userId }, status: 'ACCEPTED' },
    });
    return { activeChallenges, validatedDays };
  }
}
