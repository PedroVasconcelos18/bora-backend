export interface CreatePixChargeParams {
  amount: number;
  description: string;
  payerEmail: string;
  externalReference: string;
  expirationMinutes: number;
  idempotencyKey: string;
}

export interface PixChargeResult {
  externalId: string;
  qrCode: string;
  qrCodeBase64: string;
  ticketUrl: string;
  expiresAt: Date;
}

export interface IPaymentProvider {
  createPixCharge(params: CreatePixChargeParams): Promise<PixChargeResult>;

  /**
   * Look a charge up at the provider.
   *
   * CONTRACT — an implementation MUST distinguish these two failures, because
   * callers respond to them in opposite ways (see PaymentNotFoundError):
   *
   *   - the provider positively says it has no such payment
   *       -> throw `PaymentNotFoundError` (permanent; caller settles locally)
   *   - anything else went wrong (5xx, timeout, network, bad credentials)
   *       -> throw whatever it was (transient; caller must NOT settle, and
   *          must let the failure surface so the work is retried)
   *
   * Never encode "not found" as a return value such as
   * `{ status: 'unknown' }` — a status string is data, and callers legitimately
   * treat any non-pending, non-approved status as TERMINAL. A fake that did
   * this made the reconciliation sweep cancel rows the provider had merely
   * failed to answer for.
   */
  getPayment(externalId: string): Promise<{ status: string; externalReference: string | null }>;
}
