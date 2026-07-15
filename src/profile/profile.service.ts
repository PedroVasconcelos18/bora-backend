import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ProfileStats {
  activeChallenges: number;
  validatedDays: number;
}

export interface ProfilePixKey {
  pixKey: string | null;
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

  /**
   * GET /profile (D-1 canonical Pix key). Scoped strictly to `userId` (D-12),
   * mirroring getStats — never accepts a user id from the caller.
   */
  async getProfile(userId: string): Promise<ProfilePixKey> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { pixKey: true },
    });
    return { pixKey: row?.pixKey ?? null };
  }

  /**
   * PATCH /profile (D-4: trim-only, no format validation). A trimmed-empty
   * value clears the key (stores null); a non-empty trimmed value is stored
   * verbatim.
   */
  async updatePixKey(userId: string, rawPixKey: string | undefined): Promise<ProfilePixKey> {
    const trimmed = (rawPixKey ?? '').trim();
    const value = trimmed.length > 0 ? trimmed : null;
    await this.prisma.user.update({ where: { id: userId }, data: { pixKey: value } });
    return { pixKey: value };
  }
}
