import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationType } from '../generated/prisma/client.js';
import { PUSH_CONFIG_BY_TYPE } from './config/push-copy.config';

/**
 * Owns the WRITES to `notification_preferences` that `PushService.getPushTargets`
 * (Plan 12-03) reads at send time. Every method takes `userId` as an explicit
 * first parameter and every query/write is scoped by it —
 * `PushPreferencesController` resolves that id exclusively from
 * `@CurrentUser()`, never from a client-supplied body/query/param (T-12-14).
 *
 * D12-07's invariant: a row only exists for a DEVIATION from
 * `PUSH_CONFIG_BY_TYPE[type].defaultEnabled`. Absence of a row always means
 * "the default applies" — `setPreference` enforces this by deleting the row
 * instead of writing one whenever the incoming value matches the default, so
 * that invariant never rots into a half-truth. `deleteMany` (not `delete`) is
 * deliberate here too: deleting an override that never existed is a no-op,
 * not an error — the same discipline `notifications.service.ts` already
 * applies to its own swallowed P2002.
 */
@Injectable()
export class PushPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves all 9 `NotificationType` entries for `userId`: an override value
   * where one exists, `PUSH_CONFIG_BY_TYPE[type].defaultEnabled` otherwise.
   * Iterates `PUSH_CONFIG_BY_TYPE`'s own key order (the `enum NotificationType`
   * declaration order), so the response order is stable across calls.
   */
  async listPreferences(
    userId: string,
  ): Promise<Array<{ type: NotificationType; enabled: boolean }>> {
    const overrides = await this.prisma.notificationPreference.findMany({
      where: { userId },
    });
    const overrideByType = new Map(overrides.map((row) => [row.type, row.enabled]));

    return (Object.keys(PUSH_CONFIG_BY_TYPE) as NotificationType[]).map((type) => ({
      type,
      enabled: overrideByType.get(type) ?? PUSH_CONFIG_BY_TYPE[type].defaultEnabled,
    }));
  }

  /**
   * Materializes an override ONLY when `enabled` deviates from
   * `PUSH_CONFIG_BY_TYPE[type].defaultEnabled` — writing a row equal to the
   * default would make "absence of a row = default" a lie, and would freeze
   * this user out of ever benefiting from a future change to that type's
   * default even though they never touched the switch (D12-07).
   */
  async setPreference(userId: string, type: NotificationType, enabled: boolean): Promise<void> {
    if (enabled === PUSH_CONFIG_BY_TYPE[type].defaultEnabled) {
      await this.prisma.notificationPreference.deleteMany({ where: { userId, type } });
      return;
    }

    await this.prisma.notificationPreference.upsert({
      where: { userId_type: { userId, type } },
      create: { userId, type, enabled },
      update: { enabled },
    });
  }
}
