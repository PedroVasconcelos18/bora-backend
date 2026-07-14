import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'crypto';
import {
  CreatePixChargeParams,
  IPaymentProvider,
  PixChargeResult,
} from '../interfaces/payment-provider.interface';

const DEFAULT_APPROVE_DELAY_MS = 8000;

type FakeChargeStatus = 'pending' | 'approved';

interface FakeCharge {
  status: FakeChargeStatus;
  externalReference: string;
}

/**
 * FakePixAdapter — DEV-ONLY simulator for local testing of the Pix
 * pay -> approve -> activate loop.
 *
 * Why this exists: the Mercado Pago sandbox never approves test Pix
 * charges (verified empirically — `payer.first_name = "APRO"` does not
 * auto-approve, and MP's own docs confirm there's no way to close the
 * loop on a test Pix charge). Without this adapter, neither the webhook
 * path nor the deadline-sweep cron can be exercised locally.
 *
 * Only Mercado Pago is faked. The charge auto-approves after
 * FAKE_PIX_APPROVE_DELAY_MS and self-triggers a REAL webhook call
 * (`POST /payments/webhook`) signed with the same HMAC manifest and
 * secret the real `verifyMpSignature` util expects — so the controller,
 * signature verification, and `handleWebhook` all run for real. Never
 * constructed in production: `createPaymentProvider` (Task 2) throws at
 * boot if PAYMENT_PROVIDER=fake with NODE_ENV=production, so this class
 * is never instantiated there.
 */
@Injectable()
export class FakePixAdapter implements IPaymentProvider, OnModuleDestroy {
  private readonly logger = new Logger(FakePixAdapter.name);
  private readonly charges = new Map<string, FakeCharge>();
  private readonly pendingTimers = new Set<NodeJS.Timeout>();

  private readonly webhookSecret: string;
  private readonly approveDelayMs: number;
  private readonly webhookUrl: string;

  constructor(private readonly config: ConfigService) {
    // Same secret the real PaymentsService.verifySignature reads via
    // getOrThrow — the fake signs its self-triggered webhook with it, so
    // without it the controller would reject every fake notification
    // with 403. Only ever constructed when PAYMENT_PROVIDER=fake, so this
    // never affects a production boot.
    this.webhookSecret = this.config.getOrThrow<string>('MERCADOPAGO_WEBHOOK_SECRET');

    const rawDelay = this.config.get<string | number>('FAKE_PIX_APPROVE_DELAY_MS');
    const parsedDelay = Number(rawDelay);
    this.approveDelayMs =
      Number.isFinite(parsedDelay) && parsedDelay >= 0 ? parsedDelay : DEFAULT_APPROVE_DELAY_MS;

    const explicitUrl = this.config.get<string>('FAKE_PIX_WEBHOOK_URL');
    const port = this.config.get<string | number>('PORT') ?? 3000;
    // 127.0.0.1, never localhost — localhost resolves via IPv6 to an
    // empty Postgres in this project's Docker setup, a prior incident.
    this.webhookUrl = explicitUrl ?? `http://127.0.0.1:${port}/payments/webhook`;

    this.logger.warn(
      `FakePixAdapter active (dev-only): approveDelayMs=${this.approveDelayMs}, webhookUrl=${this.webhookUrl}`,
    );
  }

  async createPixCharge(params: CreatePixChargeParams): Promise<PixChargeResult> {
    const externalId = `fake-${randomUUID()}`;

    this.charges.set(externalId, {
      status: 'pending',
      externalReference: params.externalReference,
    });

    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      void this.approveAndNotify(externalId);
    }, this.approveDelayMs);
    timer.unref();
    this.pendingTimers.add(timer);

    this.logger.log(
      `createPixCharge: fake charge ${externalId} created (externalReference=${params.externalReference}) — will auto-approve in ${this.approveDelayMs}ms`,
    );

    return {
      externalId,
      qrCode: `00020126-fake-copia-e-cola-${externalId}`,
      qrCodeBase64: Buffer.from(`fake-qr-${externalId}`).toString('base64'),
      ticketUrl: `https://fake-pix.local/ticket/${externalId}`,
      expiresAt: new Date(Date.now() + params.expirationMinutes * 60_000),
    };
  }

  async getPayment(externalId: string): Promise<{ status: string; externalReference: string | null }> {
    const charge = this.charges.get(externalId);

    if (!charge) {
      this.logger.warn(`getPayment: unknown fake externalId=${externalId}`);
      return { status: 'unknown', externalReference: null };
    }

    return { status: charge.status, externalReference: charge.externalReference };
  }

  private async approveAndNotify(externalId: string): Promise<void> {
    const charge = this.charges.get(externalId);
    if (!charge) return;

    // Mark approved BEFORE firing the webhook — handleWebhook re-queries
    // psp.getPayment(dataId) and only approves on 'approved'; reversing
    // this order would make the fake sabotage its own notification.
    charge.status = 'approved';

    const ts = String(Date.now());
    const xRequestId = randomUUID();
    const manifest = `id:${externalId};request-id:${xRequestId};ts:${ts};`;
    const hmacHex = createHmac('sha256', this.webhookSecret).update(manifest).digest('hex');

    const url = `${this.webhookUrl}?data.id=${encodeURIComponent(externalId)}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature': `ts=${ts},v1=${hmacHex}`,
          'x-request-id': xRequestId,
        },
        body: JSON.stringify({ action: 'payment.updated', type: 'payment', data: { id: externalId } }),
      });

      if (!response.ok) {
        this.logger.error(
          `approveAndNotify: webhook POST to ${url} returned status=${response.status} (403 likely means MERCADOPAGO_WEBHOOK_SECRET mismatch between the fake and PaymentsService)`,
        );
      } else {
        this.logger.log(`approveAndNotify: fake charge ${externalId} approved — webhook delivered to ${url}`);
      }
    } catch (err) {
      this.logger.error(
        `approveAndNotify: failed to POST webhook to ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  onModuleDestroy(): void {
    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
  }
}
