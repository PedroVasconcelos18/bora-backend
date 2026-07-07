import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { IEmailProvider, SendEmailParams } from '../interfaces/email-provider.interface';

/**
 * ResendAdapter implements IEmailProvider using the official Resend SDK.
 *
 * Dev-mode behaviour (EMAIL_ADAPTER_DEV_NOTE):
 * If RESEND_API_KEY is empty/unset, the adapter logs the email to the console
 * and returns success — no real API call is made. This keeps invite dispatch
 * testable in local dev / CI without a live Resend account.
 * When a real key is present, the Resend API is called normally.
 */
@Injectable()
export class ResendAdapter implements IEmailProvider {
  private readonly resend: Resend | null;
  private readonly fromAddress: string;
  private readonly logger = new Logger(ResendAdapter.name);

  constructor(private readonly config: ConfigService) {
    const apiKey = config.get<string>('RESEND_API_KEY') ?? '';
    this.fromAddress = config.get<string>('EMAIL_FROM') ?? 'Bora <noreply@borajuntos.app>';

    if (apiKey) {
      this.resend = new Resend(apiKey);
      this.logger.log('ResendAdapter: live mode (RESEND_API_KEY present)');
    } else {
      this.resend = null;
      this.logger.warn(
        'ResendAdapter: RESEND_API_KEY is empty — emails will be logged to console only (dev/CI mode)',
      );
    }
  }

  async send(params: SendEmailParams): Promise<{ id?: string }> {
    if (!this.resend) {
      // Dev-mode fallback: log to console, return success
      this.logger.log(
        `[DEV EMAIL] To: ${params.to} | Subject: ${params.subject} | (no real send — RESEND_API_KEY not set)`,
      );
      return { id: undefined };
    }

    const { data, error } = await this.resend.emails.send({
      from: this.fromAddress,
      to: [params.to],
      subject: params.subject,
      html: params.html,
    });

    if (error) {
      this.logger.error(`Email send failed to ${params.to}: ${error.message}`);
      throw new Error(`Email send failed: ${error.message}`);
    }

    return { id: data?.id };
  }
}
