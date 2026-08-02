import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationType, Prisma } from '../generated/prisma/client.js';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { PUSH_CONFIG_BY_TYPE } from './config/push-copy.config';

export interface PushStatus {
  enabled: boolean;
  endpoints: string[];
}

export interface ReminderTarget {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface ReminderTargets {
  enabled: boolean;
  subscriptions: ReminderTarget[];
}

/**
 * Owns `push_subscriptions` + `notification_preferences`. D12-07 replaces
 * the Phase 11 single-boolean-per-user shape: the device subscription is
 * the master gate (no subscription = nothing sent, no preference even
 * read), and `notification_preferences` now holds one row per (user, type)
 * ONLY for deviations from that type's `PUSH_CONFIG_BY_TYPE[type].defaultEnabled`
 * — absence of a row means the default applies.
 *
 * Every method takes `userId` as an explicit parameter and every write/read
 * is scoped by it. PushController resolves that userId exclusively from
 * `@CurrentUser()` — never from a client-supplied body/query/param value
 * (T-11-07/08/09 in the phase threat model).
 */
@Injectable()
export class PushService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upsert keyed on the unique `endpoint` — a device can only ever belong to
   * one row. On conflict the row is re-pointed at the calling userId: a
   * browser profile that changed accounts must not keep delivering to the
   * old one.
   *
   * Never touches `notification_preferences` (Pitfall 1, 12-RESEARCH.md):
   * the frontend's `usePushSubscription` self-reconciliation calls this
   * endpoint on its own, without any user gesture, whenever it detects the
   * server lost the device's subscription — writing a preference here would
   * let that background call silently revert per-type choices the person
   * never touched in that session.
   */
  async upsertSubscription(userId: string, dto: CreateSubscriptionDto): Promise<PushStatus> {
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      create: {
        userId,
        endpoint: dto.endpoint,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
      },
      update: {
        userId,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
      },
    });

    return this.getStatus(userId);
  }

  /**
   * Ownership-scoped delete: `deleteMany` filtered on BOTH endpoint AND
   * userId, never `delete` by endpoint alone (T-11-07) — an endpoint
   * supplied by a caller must never be able to remove another person's
   * device row.
   *
   * Never touches `notification_preferences` either (same Pitfall 1 as
   * `upsertSubscription` above) — removing the last device must not erase
   * per-type overrides the person set while they had one.
   */
  async deleteSubscription(userId: string, endpoint: string): Promise<PushStatus> {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint, userId } });

    return this.getStatus(userId);
  }

  /**
   * GET /push/status — the database half of the Discretion #4 "ativo" badge
   * intersection (the browser half is computed client-side). `enabled` now
   * means "this user has at least one device subscribed" — per-type
   * preference no longer fits this endpoint's shape (it's N rows now,
   * served by `GET /push/preferences`, Plan 12-04). The response shape
   * `{ enabled, endpoints }` is unchanged, so `derivePushCardState` in
   * `bora-frontend` needs no edit.
   */
  async getStatus(userId: string): Promise<PushStatus> {
    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { userId },
      select: { endpoint: true },
    });

    return {
      enabled: subscriptions.length > 0,
      endpoints: subscriptions.map((s) => s.endpoint),
    };
  }

  /**
   * D12-07's read: the subscription is the porteiro (gatekeeper) — checked
   * FIRST, and if there are zero subscriptions this returns empty without
   * ever reading `notification_preferences`. Only when at least one device
   * is subscribed does it consult the per-type override, falling back to
   * `PUSH_CONFIG_BY_TYPE[type].defaultEnabled` when no override row exists.
   */
  async getPushTargets(userId: string, type: NotificationType): Promise<ReminderTargets> {
    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });

    if (subscriptions.length === 0) {
      return { enabled: false, subscriptions: [] };
    }

    const override = await this.prisma.notificationPreference.findUnique({
      where: { userId_type: { userId, type } },
    });
    const enabled = override?.enabled ?? PUSH_CONFIG_BY_TYPE[type].defaultEnabled;

    return enabled ? { enabled: true, subscriptions } : { enabled: false, subscriptions: [] };
  }

  /**
   * Temporary bridge so `PushSenderService` (Plan 11-04) keeps compiling
   * without edits this wave — Plan 12-05 deletes this method (and this
   * comment) once it rewires the sender to call `getPushTargets` directly.
   */
  async getReminderTargets(userId: string): Promise<ReminderTargets> {
    return this.getPushTargets(userId, 'EVIDENCE_REMINDER');
  }

  /**
   * D-09 dead-subscription removal: the single delete the Plan 11-04
   * listener calls when a push service answers 404/410. Swallows a
   * record-not-found error — the row already being gone is not a failure.
   */
  async pruneSubscription(id: string): Promise<void> {
    try {
      await this.prisma.pushSubscription.delete({ where: { id } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return;
      }
      throw err;
    }
  }
}
