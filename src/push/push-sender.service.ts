import { Inject, Injectable, Logger } from '@nestjs/common';
import { IPushProvider, PushPayload as ProviderPushPayload } from './interfaces/push-provider.interface';
import { PushService, ReminderTarget } from './push.service';
import { PrismaService } from '../prisma/prisma.service';
import { PUSH_CONFIG_BY_TYPE, PushNotificationRow } from './config/push-copy.config';

/**
 * PushSenderService — turns a persisted `notification` row into an actual
 * web-push send. Phase 12 deliberately reverses Phase 11's D-04 cut: this
 * class still never hard-codes the NAME of a notification type in its own
 * logic — `sendForNotification` reads `PUSH_CONFIG_BY_TYPE[row.type]` and
 * knows nothing else about what a type means. The one nominal exception is
 * `EVIDENCE_REMINDER`: its aggregate, cross-challenge body ("N desafios
 * esperando evidência hoje") does not fit a one-row `buildPayload`
 * signature, so `sendEvidenceReminder` stays the only place that builds
 * that copy by hand — everything past target resolution is shared with
 * `sendForNotification` via the private send loop below.
 *
 * Injects the push transport by DI token only, never the concrete
 * `WebPushAdapter` — D-02, mirrors `EmailModule`'s
 * `'EMAIL_PROVIDER'` convention), plus `PushService` (the only door to
 * `push_subscriptions`/`notification_preferences` — D-08) and
 * `PrismaService` (the single `challenge.title` lookup the 1-pending-challenge
 * body needs, plus whatever a type's `buildPayload` needs via `PushCopyContext`).
 *
 * Neither public method ever rejects on a send failure: every
 * per-subscription send runs inside its own try/catch (mirrors
 * `invites.service.ts`'s `dispatchInvites`), so one dead device never stops
 * the rest of a person's subscriptions from being tried (D-03's
 * fire-and-forget discipline, T-11-14). `sendForNotification` CAN reject if
 * `buildPayload` itself throws (e.g. `EVIDENCE_REMINDER`'s deliberate guard)
 * — the caller (`PushListener`) is the one that catches that.
 */
@Injectable()
export class PushSenderService {
  private readonly logger = new Logger(PushSenderService.name);

  constructor(
    @Inject('PUSH_PROVIDER') private readonly push: IPushProvider,
    private readonly pushService: PushService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * `challengeIds` is whatever `PushListener` coalesced for this user/day —
   * one entry when the person has exactly one pending challenge, more than
   * one when several fired inside the same coalescing window (Discretion #1).
   */
  async sendEvidenceReminder(
    userId: string,
    evidenceDate: string,
    challengeIds: string[],
  ): Promise<void> {
    // Step 1 — the SC-2 gate. Eligibility for *who gets a reminder at all*
    // stays entirely the untouched cron's call; this only decides whether
    // that person also wanted it on their phone.
    const targets = await this.pushService.getPushTargets(userId, 'EVIDENCE_REMINDER');
    if (!targets.enabled || targets.subscriptions.length === 0) {
      return;
    }

    const uniqueChallengeIds = [...new Set(challengeIds)];

    let body: string;
    let url: string;

    if (uniqueChallengeIds.length === 1) {
      const challenge = await this.prisma.challenge.findUnique({
        where: { id: uniqueChallengeIds[0] },
        select: { title: true },
      });
      // Same defensive shape as the in-app listener: a challenge that no
      // longer exists by send time means nothing to point the tap at.
      if (!challenge) {
        return;
      }

      body = `Falta a sua evidência de hoje no ${challenge.title}`;
      url = `/challenges/${uniqueChallengeIds[0]}`;
    } else {
      body = `Você tem ${uniqueChallengeIds.length} desafios esperando evidência hoje`;
      url = '/home';
    }

    const payload = {
      // Camera emoji from EMOJI_BY_TYPE, plain "Bora" — bora-frontend/src/lib/notifications.ts:46.
      title: '📸 Bora',
      body,
      url,
      // Same-day repeat collapses instead of stacking on the lock screen.
      tag: `evidence-reminder-${evidenceDate}`,
      // No `actions` — iOS/Android disagree on action-button support and
      // SC-1 needs both platforms identical (11-UI-SPEC.md).
    };

    await this.sendToSubscriptions(targets.subscriptions, payload, 'EVIDENCE_REMINDER');
  }

  /**
   * The generalized path (Phase 12): any of the 9 `NotificationType` rows
   * the funnel persists becomes a push here, driven entirely by
   * `PUSH_CONFIG_BY_TYPE`. Adding a 10th type never touches this method.
   */
  async sendForNotification(row: PushNotificationRow): Promise<void> {
    const targets = await this.pushService.getPushTargets(row.userId, row.type);
    if (!targets.enabled || targets.subscriptions.length === 0) {
      return;
    }

    const config = PUSH_CONFIG_BY_TYPE[row.type];
    if (!config) {
      // A type with no map entry is a programming bug (every NotificationType
      // must have an entry), not a data problem — still must not crash the
      // caller's event handling of other, unrelated rows.
      this.logger.warn(`No PUSH_CONFIG_BY_TYPE entry for notification type ${String(row.type)} — skipping.`);
      return;
    }

    const payload = await config.buildPayload(row, { prisma: this.prisma });
    await this.sendToSubscriptions(targets.subscriptions, payload, row.type);
  }

  /**
   * Shared send/prune loop (extracted from the tail of `sendEvidenceReminder`
   * — behavior is byte-identical, only the `type` parameter is new). Per-
   * subscription try/catch: the same per-item resilience the cron's own loop
   * has (T-11-14). A `logger.log` at the end stamps `type` and the attempted
   * count — with no send-log table and no dashboard, this is what lets a
   * Railway log search answer "did this type go out today?" (Pitfall 5,
   * 12-RESEARCH.md).
   */
  private async sendToSubscriptions(
    subscriptions: ReminderTarget[],
    payload: ProviderPushPayload,
    type: string,
  ): Promise<void> {
    for (const subscription of subscriptions) {
      try {
        await this.push.send({
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          payload,
        });
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // D-09 — the only signal a dead subscription ever emits; on iOS
          // the only way to learn the home-screen icon was deleted.
          await this.pushService.pruneSubscription(subscription.id);
          continue;
        }
        this.logger.warn(
          `Push send failed for subscription ${subscription.id} (type=${type}, status=${statusCode ?? 'unknown'}): ${String(err)}`,
        );
      }
    }

    this.logger.log(`Push send attempted for type=${type}, subscriptions=${subscriptions.length}`);
  }
}
