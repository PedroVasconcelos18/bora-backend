/**
 * The payment provider does not know this payment id — and never will.
 *
 * This is the PSP-agnostic normalization of a *permanent* lookup failure
 * (Mercado Pago answers `404 { error: 'not_found', cause: [{ code: 2000 }] }`).
 * It is deliberately a distinct type from every other provider failure,
 * because the two demand OPPOSITE responses:
 *
 *   - PaymentNotFoundError  -> PERMANENT. Retrying can never succeed. The
 *                              caller must settle the item locally (cancel it,
 *                              or acknowledge and drop the notification).
 *   - anything else (5xx,    -> TRANSIENT/UNKNOWN. Retrying may well succeed,
 *     timeout, network, DNS)    so the caller must NOT settle anything and must
 *                               let the failure surface.
 *
 * Why an error type and not a `null` return: this repo compiles with
 * `strictNullChecks: false` (tsconfig.json), so a `Promise<T | null>` signature
 * would give ZERO compile-time pressure on callers — `confirmed.status` on a
 * null would keep compiling and blow up at runtime, which is the exact class of
 * failure this fix exists to remove. Both call sites must have a try/catch
 * regardless (a transient provider failure has to be caught either way), so a
 * typed error keeps absence and failure in ONE control-flow construct instead
 * of two.
 *
 * Constructed ONLY inside `payments/adapters/` — that is what keeps
 * `status === 404` / `code: 2000` (Mercado Pago's dialect) from leaking into
 * PaymentsService or the scheduler. Callers match on the type, never on a
 * PSP-shaped object.
 */
export class PaymentNotFoundError extends Error {
  /** The provider-side id that was looked up (our `Payment.externalId`). */
  readonly externalId: string;

  /**
   * The provider's own error payload, ALREADY serialized to a string by the
   * adapter. A string, not the raw object, on purpose: the PSP's response shape
   * stops at the adapter boundary, and callers can still log the real reason.
   */
  readonly providerDetail?: string;

  constructor(externalId: string, providerDetail?: string) {
    super(`Payment provider has no payment with externalId=${externalId}`);
    this.name = 'PaymentNotFoundError';
    this.externalId = externalId;
    this.providerDetail = providerDetail;

    // Defensive: `instanceof` on an Error subclass silently breaks if the
    // compile target is ever downgraded to ES5. Both call sites branch on
    // `instanceof` to decide between "settle this item" and "let it retry" on
    // the money path — a silent false there would resurrect this exact bug.
    Object.setPrototypeOf(this, PaymentNotFoundError.prototype);
  }
}
