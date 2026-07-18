import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ProfileStats {
  activeChallenges: number;
  validatedDays: number;
}

export interface ProfilePixKey {
  /** Legacy "primary" key = pixKeys[0] — kept for the payout/refund fallback. */
  pixKey: string | null;
  /** All saved Pix keys (up to MAX_PIX_KEYS). */
  pixKeys: string[];
}

/** Feedback: usuário pode cadastrar até 5 chaves Pix. */
export const MAX_PIX_KEYS = 5;

/**
 * Normalize a raw list of Pix keys: trim each, drop blanks, dedupe (keeping
 * first occurrence), and cap at MAX_PIX_KEYS. D-4 stays: trim-only, no
 * CPF/email/phone format validation.
 */
export function normalizePixKeys(raw: string[] | undefined): string[] {
  const out: string[] = [];
  for (const item of raw ?? []) {
    const trimmed = (item ?? '').trim();
    if (trimmed.length === 0) continue;
    if (out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= MAX_PIX_KEYS) break;
  }
  return out;
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
      select: { pixKey: true, pixKeys: true },
    });
    return { pixKey: row?.pixKey ?? null, pixKeys: row?.pixKeys ?? [] };
  }

  /**
   * PATCH /profile (D-4: trim-only, no format validation). Persists the full
   * list of Pix keys (up to MAX_PIX_KEYS, deduped, blanks dropped) and mirrors
   * the first one into the legacy `pixKey` column so the payout/refund
   * fallback (participant.pixKey ?? user.pixKey) keeps working unchanged.
   */
  async updatePixKeys(userId: string, rawKeys: string[] | undefined): Promise<ProfilePixKey> {
    const pixKeys = normalizePixKeys(rawKeys);
    const primary = pixKeys[0] ?? null;
    await this.prisma.user.update({
      where: { id: userId },
      data: { pixKeys, pixKey: primary },
    });
    return { pixKey: primary, pixKeys };
  }
}
