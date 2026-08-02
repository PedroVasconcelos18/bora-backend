import { Injectable } from '@nestjs/common';
import { NotificationType } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service';
import { saoPauloDay } from '../common/utils/sao-paulo-day.util';
import { PushSenderService } from './push-sender.service';
import { PushService } from './push.service';
import { PUSH_CONFIG_BY_TYPE, PushPayload } from './config/push-copy.config';
import { EVIDENCE_REMINDER_PREVIEW, PUSH_PREVIEW_FIXTURES } from './config/push-preview.fixtures';
import { AdminTestPushDto } from './dto/admin-test-push.dto';

export interface PushPayloadPreview extends PushPayload {
  variant: string;
}

export interface AdminPushTestResult {
  type: NotificationType;
  status: 'previewed' | 'sent' | 'skipped_no_subscription' | 'error';
  previews?: PushPayloadPreview[];
  variants?: string[];
  subscriptions?: number;
  note?: string;
  error?: string;
}

export interface AdminPushTestResponse {
  dryRun: boolean;
  userId: string;
  evidenceDate: string;
  results: AdminPushTestResult[];
}

/**
 * PushAdminService — the operator test bench behind `POST /admin/push/test`
 * (Quick task 260802-by6). This is the ONLY place in the backend that ever
 * passes `{ ignorePreference: true }` to `PushService.getPushTargets` /
 * `PushSenderService.sendForNotification` / `.sendEvidenceReminder` — it
 * exists because a TEST endpoint that silently swallows a send due to the
 * operator's own preference setting is the opposite of what a test endpoint
 * is for. The device-subscription porteiro is never bypassed: zero
 * `PushSubscription` rows always reports `skipped_no_subscription`, never a
 * faked `sent` (PIT-2).
 *
 * Two modes, both driven by the same type resolution:
 * - `dryRun: true` — renders copy via each type's `buildPayload` (or, for
 *   `EVIDENCE_REMINDER`, via `PushSenderService.buildEvidenceReminderPayload`,
 *   PIT-1) against synthetic fixtures. Never touches `PushSubscription`,
 *   never calls the provider (D-01).
 * - no `dryRun` — sends for real, through the exact same
 *   `PushSenderService` methods production uses, with the preference bypass
 *   layered on top via options.
 *
 * Types are processed in sequence, each inside its own try/catch, so one
 * type's failure (or `type: 'ALL'`'s 9-type fan-out) never stops the rest
 * from reporting a result.
 */
@Injectable()
export class PushAdminService {
  constructor(
    private readonly pushSender: PushSenderService,
    private readonly pushService: PushService,
    private readonly prisma: PrismaService,
  ) {}

  async run(dto: AdminTestPushDto): Promise<AdminPushTestResponse> {
    const evidenceDate = saoPauloDay();
    const dryRun = dto.dryRun ?? false;
    const types = this.resolveTypes(dto.type);

    const results: AdminPushTestResult[] = [];
    for (const type of types) {
      try {
        results.push(
          dryRun ? await this.previewType(type) : await this.sendType(type, dto, evidenceDate),
        );
      } catch (err) {
        results.push({
          type,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { dryRun, userId: dto.userId, evidenceDate, results };
  }

  /** `'ALL'` -> every key of `PUSH_CONFIG_BY_TYPE`, same stable enum order
   * `PushPreferencesService.listPreferences` already relies on. Absence of
   * `type` -> `EVIDENCE_REMINDER`, preserving the legacy caller (QT-01). */
  private resolveTypes(type: AdminTestPushDto['type']): NotificationType[] {
    if (type === 'ALL') {
      return Object.keys(PUSH_CONFIG_BY_TYPE) as NotificationType[];
    }
    return [type ?? 'EVIDENCE_REMINDER'];
  }

  private async previewType(type: NotificationType): Promise<AdminPushTestResult> {
    if (type === 'EVIDENCE_REMINDER') {
      return this.previewEvidenceReminder(type);
    }

    const fixtures = PUSH_PREVIEW_FIXTURES[type];
    const config = PUSH_CONFIG_BY_TYPE[type];
    const previews: PushPayloadPreview[] = [];
    for (const fixture of fixtures) {
      const payload = await config.buildPayload(fixture.row, { prisma: this.prisma });
      previews.push({ variant: fixture.variant, ...payload });
    }

    return { type, status: 'previewed', previews };
  }

  /** PIT-1 — never calls `PUSH_CONFIG_BY_TYPE.EVIDENCE_REMINDER.buildPayload`
   * (it throws by design, D12-02); renders both variants through the single
   * shared copy builder instead. */
  private async previewEvidenceReminder(type: NotificationType): Promise<AdminPushTestResult> {
    const previews: PushPayloadPreview[] = [];

    const single = await this.pushSender.buildEvidenceReminderPayload(
      saoPauloDay(),
      EVIDENCE_REMINDER_PREVIEW.singleChallengeIds,
      { fallbackTitle: EVIDENCE_REMINDER_PREVIEW.fallbackTitle },
    );
    if (single) {
      previews.push({ variant: 'um-desafio', ...single });
    }

    const multi = await this.pushSender.buildEvidenceReminderPayload(
      saoPauloDay(),
      EVIDENCE_REMINDER_PREVIEW.multiChallengeIds,
    );
    if (multi) {
      previews.push({ variant: 'varios-desafios', ...multi });
    }

    return { type, status: 'previewed', previews };
  }

  private async sendType(
    type: NotificationType,
    dto: AdminTestPushDto,
    evidenceDate: string,
  ): Promise<AdminPushTestResult> {
    // PIT-2 — the bypass that makes even a default-off type (EVIDENCE_SUBMITTED,
    // D12-04) testable without the operator opting in first. The device
    // porteiro still stands: zero subscriptions never fakes a send.
    const targets = await this.pushService.getPushTargets(dto.userId, type, {
      ignorePreference: true,
    });

    if (targets.subscriptions.length === 0) {
      return { type, status: 'skipped_no_subscription', subscriptions: 0 };
    }

    if (type === 'EVIDENCE_REMINDER') {
      return this.sendEvidenceReminderType(dto, evidenceDate, targets.subscriptions.length);
    }

    const fixtures = PUSH_PREVIEW_FIXTURES[type];
    const variants: string[] = [];
    for (const fixture of fixtures) {
      await this.pushSender.sendForNotification(fixture.row, { ignorePreference: true });
      variants.push(fixture.variant);
    }

    return { type, status: 'sent', subscriptions: targets.subscriptions.length, variants };
  }

  private async sendEvidenceReminderType(
    dto: AdminTestPushDto,
    evidenceDate: string,
    subscriptionCount: number,
  ): Promise<AdminPushTestResult> {
    const hasCallerIds = !!dto.challengeIds && dto.challengeIds.length > 0;
    const ids = hasCallerIds ? dto.challengeIds! : EVIDENCE_REMINDER_PREVIEW.multiChallengeIds;

    await this.pushSender.sendEvidenceReminder(dto.userId, evidenceDate, ids, {
      ignorePreference: true,
    });

    const result: AdminPushTestResult = {
      type: 'EVIDENCE_REMINDER',
      status: 'sent',
      subscriptions: subscriptionCount,
      variants: ['evidence-reminder'],
    };
    if (!hasCallerIds) {
      result.note = 'Nenhum challengeIds informado — enviado com ids sintéticos de preview.';
    }
    return result;
  }
}
