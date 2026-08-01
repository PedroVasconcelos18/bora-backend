import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { IPushProvider, SendPushParams } from '../interfaces/push-provider.interface';

/**
 * WebPushAdapter implements IPushProvider using the `web-push` npm library.
 *
 * Fail-loud-at-boot (WEB_PUSH_ADAPTER_DEV_NOTE):
 * Unlike ResendAdapter, there is NO dev-mode fallback branch here. A backend
 * booted without valid VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
 * throws during construction and refuses to start. CONTEXT.md's folded todo
 * is explicit: the failure mode to avoid is going silently mute at 18h when
 * nobody is watching, so a misconfigured deployment must refuse to boot
 * instead of degrading to a no-op.
 */
@Injectable()
export class WebPushAdapter implements IPushProvider {
  private readonly logger = new Logger(WebPushAdapter.name);

  constructor(private readonly config: ConfigService) {
    const publicKey = config.get<string>('VAPID_PUBLIC_KEY') ?? '';
    const privateKey = config.get<string>('VAPID_PRIVATE_KEY') ?? '';
    const subject = config.get<string>('VAPID_SUBJECT') ?? '';

    if (!publicKey) {
      throw new Error(
        'VAPID_PUBLIC_KEY is empty — the backend cannot send push reminders without it.',
      );
    }
    if (!privateKey) {
      throw new Error(
        'VAPID_PRIVATE_KEY is empty — the backend cannot send push reminders without it.',
      );
    }
    if (!subject) {
      throw new Error(
        'VAPID_SUBJECT is empty — the backend cannot send push reminders without it.',
      );
    }
    if (!subject.startsWith('mailto:') && !subject.startsWith('https://')) {
      throw new Error(
        `VAPID_SUBJECT must be a "mailto:" address or an "https://" URL per RFC 8292 — got "${subject}".`,
      );
    }

    // Let web-push throw if the key pair itself is malformed (wrong length,
    // not valid URL-safe base64, etc.) — no try/catch here, same fail-loud
    // rule as the empty-value checks above.
    webpush.setVapidDetails(subject, publicKey, privateKey);

    // Only a short prefix of the PUBLIC key is logged (T-11-04). The private
    // key and the subject must never appear in a log line.
    this.logger.log(
      `WebPushAdapter: live mode (VAPID configured, public key prefix ${publicKey.slice(0, 8)}...)`,
    );
  }

  async send(params: SendPushParams): Promise<void> {
    try {
      await webpush.sendNotification(
        { endpoint: params.endpoint, keys: params.keys },
        JSON.stringify(params.payload),
      );
    } catch (err) {
      // Never swallow — pruning a dead (404/410) subscription is the
      // listener's job (Plan 11-04), not the adapter's. Preserve the push
      // service's numeric status code as an own property so the caller can
      // distinguish a dead subscription from a transient failure (SC-6).
      const statusCode = (err as { statusCode?: number }).statusCode;
      const message = err instanceof Error ? err.message : String(err);
      const pushError = new Error(`Push send failed: ${message}`) as Error & {
        statusCode?: number;
      };
      pushError.statusCode = statusCode;
      throw pushError;
    }
  }
}
