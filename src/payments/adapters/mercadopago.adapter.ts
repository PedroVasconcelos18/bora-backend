import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import {
  CreatePixChargeParams,
  IPaymentProvider,
  PixChargeResult,
} from '../interfaces/payment-provider.interface';

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

  async getPayment(externalId: string): Promise<{ status: string; externalReference: string | null }> {
    if (!this.payment) {
      throw new Error(
        'MercadoPagoAdapter: cannot fetch a payment — MERCADOPAGO_ACCESS_TOKEN is not configured',
      );
    }

    const result = await this.payment.get({ id: externalId });

    return {
      status: result.status ?? 'unknown',
      externalReference: result.external_reference ?? null,
    };
  }
}
