import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PushSenderService } from './push-sender.service';
import { PUSH_CONFIG_BY_TYPE, PushNotificationRow } from './config/push-copy.config';

/**
 * Discretion #1's "at most one push per person per day" window, in
 * milliseconds. The cron that emits `evidence.reminder` runs its whole
 * candidate loop synchronously in one tick within a single process, so a
 * short fixed window always captures every event for that tick — a process
 * restart mid-tick would at worst split one person's push in two, which is
 * acceptable under D-03's no-outbox discipline (the same reasoning that
 * makes a lost in-app row acceptable).
 */
const COALESCE_WINDOW_MS = 2000;

interface CoalesceEntry {
  challengeIds: string[];
  timer: NodeJS.Timeout;
}

/**
 * PushListener — the SINGLE consumer of `notification.created` (D12-01/SC-2).
 * Phase 11 had this class listen to the cron's raw `evidence.reminder`
 * event directly; Phase 12 replaces that with the funnel's own event so a
 * push is only ever sent for a row that actually persisted. The branch
 * taken per event is declared in `PUSH_CONFIG_BY_TYPE[row.type].coalesce`,
 * never in an `if` keyed by type name spread across this file — adding a
 * 10th `NotificationType` never requires touching this class.
 *
 * Injects only `PushSenderService`; it must never import from the in-app
 * notifications layer, so a failure in either listener can never affect the
 * other (D-03). Registers no new periodic job of its own.
 *
 * `@nestjs/event-emitter` already wraps every `@OnEvent` handler with
 * `suppressErrors` defaulting to `true`, so no top-level try/catch is needed
 * around the handler itself — only the deferred `flush` (window branch) and
 * the direct branch's own `.catch` guard their own awaits, because both run
 * outside the synchronous body the library wraps.
 */
@Injectable()
export class PushListener {
  private readonly logger = new Logger(PushListener.name);
  private readonly windows = new Map<string, CoalesceEntry>();

  constructor(private readonly pushSender: PushSenderService) {}

  @OnEvent('notification.created')
  handleNotificationCreated(row: PushNotificationRow): void {
    const config = PUSH_CONFIG_BY_TYPE[row.type];
    if (!config) {
      return;
    }

    if (config.coalesce === 'evidence-reminder-window') {
      this.handleEvidenceReminderWindow(row);
      return;
    }

    // Direct branch — every other type sends immediately, no window. The
    // `.catch` is mandatory: without it, a `buildPayload` rejection (e.g. a
    // future type with a bug) would become an unhandled promise rejection
    // in the process, since this handler itself is synchronous (`void`) and
    // `@nestjs/event-emitter` cannot wrap a promise it never receives.
    this.pushSender.sendForNotification(row).catch((err: unknown) => {
      this.logger.warn(`sendForNotification failed for type=${row.type}, id=${row.id}: ${String(err)}`);
    });
  }

  /**
   * D12-02: `NotificationsListener.handleEvidenceReminder` now writes
   * `evidenceDate` into the row's payload — the primary read. The second
   * segment of `entityId` (`participantId:evidenceDate`, with
   * `participantId` a uuid that never contains `:`) is the safety net for
   * any row written before that payload field existed.
   */
  private handleEvidenceReminderWindow(row: PushNotificationRow): void {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    let evidenceDate = String(payload.evidenceDate ?? '');
    if (!evidenceDate) {
      evidenceDate = row.entityId.split(':')[1] ?? '';
    }
    if (!evidenceDate) {
      this.logger.warn(`EVIDENCE_REMINDER row ${row.id} has no resolvable evidenceDate — dropping.`);
      return;
    }

    const challengeId = String(payload.challengeId ?? '');
    const key = `${row.userId}:${evidenceDate}`;
    const existing = this.windows.get(key);

    if (existing) {
      // The window is fixed from the first event — appending here without
      // rescheduling means a large fan-out cannot push the flush
      // indefinitely into the future.
      existing.challengeIds.push(challengeId);
      return;
    }

    const timer = setTimeout(() => {
      void this.flush(key, row.userId, evidenceDate);
    }, COALESCE_WINDOW_MS);
    // Never keeps the Node process (or a jest run) alive on its own.
    timer.unref();

    this.windows.set(key, { challengeIds: [challengeId], timer });
  }

  private async flush(key: string, userId: string, evidenceDate: string): Promise<void> {
    const entry = this.windows.get(key);
    // Remove the entry first — a later event for the same user/day starts a
    // fresh window rather than reusing a flushed one.
    this.windows.delete(key);
    if (!entry) {
      return;
    }

    try {
      await this.pushSender.sendEvidenceReminder(userId, evidenceDate, entry.challengeIds);
    } catch (err) {
      this.logger.warn(`Failed to flush evidence-reminder push for ${key}: ${String(err)}`);
    }
  }
}
