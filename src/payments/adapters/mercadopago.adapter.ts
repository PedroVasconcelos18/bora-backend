import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { PaymentNotFoundError } from '../errors/payment-not-found.error';
import {
  CreatePixChargeParams,
  IPaymentProvider,
  PixChargeResult,
} from '../interfaces/payment-provider.interface';
import { describeError } from '../utils/describe-error.util';

/**
 * Is this rejection Mercado Pago saying "I have no such payment"?
 *
 * The SDK does NOT reject with an `Error`: `RestClient.fetch` does
 * `throw await response.json()` on any non-2xx, so what lands in the catch is
 * the raw parsed error body — a plain object. Production, 30/07/2026:
 *   `{ message: 'Payment not found', error: 'not_found', status: 404,
 *      cause: [{ code: 2000 }] }`
 *
 * This predicate is the ONLY place in the codebase allowed to know that shape.
 *
 * ONE necessary and sufficient signal: an HTTP 404 in the body's `status`.
 * Compared loosely against string and number only because the body is untyped
 * JSON — `'404'` and `404` are the same answer. Everything else, including a
 * body that carries `error: 'not_found'` with any other status or with no
 * status at all, is NOT classified.
 *
 * WHY SO NARROW (review hardening, 30/07/2026). The first version also accepted
 * `body.error === 'not_found'` on its own, reasoning that a transport omitting
 * `status` should still classify. No captured payload ever supported that, and
 * Mercado Pago is reported to answer `"error":"not_found"` alongside non-404
 * statuses — notably 401 for an invalid, expired, or wrong-account token on
 * GET /v1/payments/{id}.
 *
 * The asymmetry is total and one-way. A false positive here is destructive in
 * BOTH consumers at once: the reconciliation sweep writes CANCELLED (the row
 * leaves the `status:'PENDING'` scan permanently) and the webhook answers 200
 * (Mercado Pago stops redelivering, so the notification itself is gone). A
 * single wrong-token window would mass-cancel every live PENDING charge and
 * silently drop every `approved` that landed during it, unrecoverably, even
 * after credentials are fixed.
 *
 * A false negative costs a retry. So "cannot classify" MUST mean "not a
 * not-found": the sweep skips the row and re-checks next hour, the webhook
 * answers non-200 and Mercado Pago keeps the notification alive. That is the
 * behavior this code had BEFORE the 404 work, and it destroyed nothing.
 */
function isProviderNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }

  const { status } = err as { status?: unknown };

  return status === 404 || status === '404';
}

/**
 * MercadoPagoAdapter implements IPaymentProvider using the official mercadopago SDK.
 *
 * Unlike ResendAdapter's dev-mode-without-key fallback (which silently logs and
 * returns success for emails), a payments adapter must NOT silently fake a Pix
 * charge when MERCADOPAGO_ACCESS_TOKEN is missing — money is not something to
 * mock quietly. If the token is empty, construction still succeeds (so the app
 * can boot in environments where payments aren't exercised), but createPixCharge
 * throws immediately.
 *
 * GAP 4 (test/live observability): switching to the Mercado Pago sandbox is
 * purely an env change — set MERCADOPAGO_ACCESS_TOKEN to a TEST- prefixed
 * access token from an MP test application and use a test payer email; the
 * charge body sent to the SDK is identical either way, so no other code
 * changes are needed to exercise the QR/charge flow in sandbox.
 */
@Injectable()
export class MercadoPagoAdapter implements IPaymentProvider {
  private readonly logger = new Logger(MercadoPagoAdapter.name);
  private readonly payment: Payment | null;

  /** Resolved from the access token prefix; never derived from or logging the token value. */
  public readonly mode: 'test' | 'live' | 'unconfigured';

  constructor(private readonly config: ConfigService) {
    const accessToken = this.config.get<string>('MERCADOPAGO_ACCESS_TOKEN') ?? '';

    if (accessToken) {
      const client = new MercadoPagoConfig({
        accessToken,
        options: { timeout: 5000 },
      });
      this.payment = new Payment(client);
      this.mode = accessToken.startsWith('TEST-') ? 'test' : 'live';
      this.logger.log(`MercadoPagoAdapter: ${this.mode} mode (MERCADOPAGO_ACCESS_TOKEN present)`);
    } else {
      this.payment = null;
      this.mode = 'unconfigured';
      this.logger.warn(
        'MercadoPagoAdapter: MERCADOPAGO_ACCESS_TOKEN is empty — createPixCharge will throw (no charges can be faked)',
      );
    }
  }

  async createPixCharge(params: CreatePixChargeParams): Promise<PixChargeResult> {
    if (!this.payment) {
      throw new Error(
        'MercadoPagoAdapter: cannot create a Pix charge — MERCADOPAGO_ACCESS_TOKEN is not configured',
      );
    }

    const expiresAt = new Date(Date.now() + params.expirationMinutes * 60_000);

    const result = await this.payment.create({
      body: {
        transaction_amount: params.amount,
        description: params.description,
        payment_method_id: 'pix',
        external_reference: params.externalReference,
        date_of_expiration: expiresAt.toISOString(),
        payer: { email: params.payerEmail },
      },
      requestOptions: { idempotencyKey: params.idempotencyKey },
    });

    const transactionData = result.point_of_interaction?.transaction_data;

    if (!result.id || !transactionData?.qr_code || !transactionData?.qr_code_base64) {
      this.logger.error(
        `MercadoPagoAdapter: unexpected Pix charge response shape for external_reference=${params.externalReference}`,
      );
      throw new Error('MercadoPagoAdapter: Mercado Pago did not return a valid Pix charge');
    }

    return {
      externalId: String(result.id),
      qrCode: transactionData.qr_code,
      qrCodeBase64: transactionData.qr_code_base64,
      ticketUrl: transactionData.ticket_url ?? '',
      expiresAt,
    };
  }

  /**
   * GET /v1/payments/{id}, with the one failure mode callers must be able to
   * tell apart normalized into a typed error.
   *
   * A 404 becomes `PaymentNotFoundError` (permanent — this id will never
   * resolve). Every other rejection is rethrown untouched so it stays
   * transient: the reconciliation sweep skips that row and retries next hour,
   * and the webhook answers non-200 so Mercado Pago redelivers.
   *
   * The unconfigured-token throw below is deliberately NOT a
   * PaymentNotFoundError: a missing access token is a deployment fault, and
   * treating it as "not found" would let a misconfigured boot quietly CANCEL
   * every pending payment on the first cron tick.
   */
  async getPayment(externalId: string): Promise<{ status: string; externalReference: string | null }> {
    if (!this.payment) {
      throw new Error(
        'MercadoPagoAdapter: cannot fetch a payment — MERCADOPAGO_ACCESS_TOKEN is not configured',
      );
    }

    let result: Awaited<ReturnType<Payment['get']>>;
    try {
      result = await this.payment.get({ id: externalId });
    } catch (err) {
      if (isProviderNotFound(err)) {
        // describeError, not String(err): the SDK rejects with a plain object,
        // so String(err) would render "[object Object]" and lose `cause`.
        // Serializing HERE is what keeps the raw MP payload from travelling
        // outward — PaymentNotFoundError carries a string, not the object.
        throw new PaymentNotFoundError(externalId, describeError(err));
      }
      throw err;
    }

    if (!result.status) {
      // NIT 10 (review hardening). This used to answer `status: 'unknown'`,
      // which the interface contract explicitly forbids: a status string is
      // DATA, and callers legitimately read any non-pending, non-approved
      // status as TERMINAL — so a status-less 200 body would have flowed
      // straight into the sweep's terminal branch and been CANCELLED. Absence
      // is not a status. Thrown as a plain Error (never PaymentNotFoundError)
      // so it degrades to TRANSIENT: the sweep skips and retries, the webhook
      // answers non-200 and Mercado Pago redelivers. Nothing is settled on a
      // response we could not read.
      this.logger.error(
        `MercadoPagoAdapter: GET /v1/payments/${externalId} returned a body with no status field`,
      );
      throw new Error(
        `MercadoPagoAdapter: Mercado Pago returned no status for externalId=${externalId}`,
      );
    }

    return {
      status: result.status,
      externalReference: result.external_reference ?? null,
    };
  }
}
