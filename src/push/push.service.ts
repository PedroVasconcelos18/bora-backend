import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client.js';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';

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
 * Owns `push_subscriptions` + `notification_preferences` (D-08: a device
 * subscription and the user's single reminder preference are two separate
 * concepts, kept in step here but never merged into one row — the
 * preference survives a phone swap, the subscription doesn't).
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
   * Subscribing IS the opt-in: the only way to switch `pushRemindersEnabled`
   * on in this phase is to activate on a device (D-08 still keeps the
   * preference and the subscription as two separate concepts/rows).
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

    await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, pushRemindersEnabled: true },
      update: { pushRemindersEnabled: true },
    });

    return this.getStatus(userId);
  }

  /**
   * Ownership-scoped delete: `deleteMany` filtered on BOTH endpoint AND
   * userId, never `delete` by endpoint alone (T-11-07) — an endpoint
   * supplied by a caller must never be able to remove another person's
   * device row.
   */
  async deleteSubscription(userId: string, endpoint: string): Promise<PushStatus> {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint, userId } });

    const remaining = await this.prisma.pushSubscription.count({ where: { userId } });
    if (remaining === 0) {
      await this.prisma.notificationPreference.upsert({
        where: { userId },
        create: { userId, pushRemindersEnabled: false },
        update: { pushRemindersEnabled: false },
      });
    }

    return this.getStatus(userId);
  }

  /**
   * GET /push/status — the database half of the Discretion #4 "ativo" badge
   * intersection (the browser half is computed client-side).
   */
  async getStatus(userId: string): Promise<PushStatus> {
    const [preference, subscriptions] = await Promise.all([
      this.prisma.notificationPreference.findUnique({ where: { userId } }),
      this.prisma.pushSubscription.findMany({ where: { userId }, select: { endpoint: true } }),
    ]);

    return {
      enabled: preference?.pushRemindersEnabled ?? false,
      endpoints: subscriptions.map((s) => s.endpoint),
    };
  }

  /**
   * The single read the Plan 11-04 listener uses. When the preference is
   * disabled, returns an empty subscription list without querying rows
   * further — the gate that makes SC-2 true: someone who never activated
   * receives nothing.
   */
  async getReminderTargets(userId: string): Promise<ReminderTargets> {
    const preference = await this.prisma.notificationPreference.findUnique({ where: { userId } });
    if (!preference?.pushRemindersEnabled) {
      return { enabled: false, subscriptions: [] };
    }

    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });

    return { enabled: true, subscriptions };
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
