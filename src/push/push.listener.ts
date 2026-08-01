import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PushSenderService } from './push-sender.service';

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
 * PushListener — a second, independent consumer of `evidence.reminder`
 * (SC-3). Injects only `PushSenderService`; it must never import from the
 * in-app notifications layer, so a failure in either listener can never
 * affect the other (D-03). Adds no scheduler job of its own — this phase
 * consumes the existing cron's event, it does not create a sixth one.
 *
 * `@nestjs/event-emitter` already wraps every `@OnEvent` handler with
 * `suppressErrors` defaulting to `true`, so no top-level try/catch is needed
 * around the handler itself (mirroring the note the in-app listener already
 * carries) — only the scheduled flush below guards its own await.
 */
@Injectable()
export class PushListener {
  private readonly logger = new Logger(PushListener.name);
  private readonly windows = new Map<string, CoalesceEntry>();

  constructor(private readonly pushSender: PushSenderService) {}

  @OnEvent('evidence.reminder')
  handleEvidenceReminder(payload: {
    participantId: string;
    userId: string;
    challengeId: string;
    evidenceDate: string;
  }): void {
    const key = `${payload.userId}:${payload.evidenceDate}`;
    const existing = this.windows.get(key);

    if (existing) {
      // The window is fixed from the first event — appending here without
      // rescheduling means a large cron tick cannot push the flush
      // indefinitely into the future.
      existing.challengeIds.push(payload.challengeId);
      return;
    }

    const timer = setTimeout(() => {
      void this.flush(key, payload.userId, payload.evidenceDate);
    }, COALESCE_WINDOW_MS);
    // Never keeps the Node process (or a jest run) alive on its own.
    timer.unref();

    this.windows.set(key, { challengeIds: [payload.challengeId], timer });
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
