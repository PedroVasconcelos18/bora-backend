import { createHmac, timingSafeEqual } from 'crypto';

export interface VerifyMpSignatureParams {
  /** Raw `x-signature` header value, e.g. "ts=1704908010,v1=618c8534...". */
  xSignature: string | undefined;
  /** Raw `x-request-id` header value — omitted from the manifest when absent. */
  xRequestId: string | undefined;
  /** The `data.id` query param from the webhook notification. */
  dataId: string;
  /** MERCADOPAGO_WEBHOOK_SECRET from the MP dashboard. */
  secret: string;
}

/**
 * Verifies the Mercado Pago `x-signature` webhook header (PAY-03, D-15).
 *
 * Manifest format (cross-verified, RESEARCH.md Code Examples §2 / Pitfall 2):
 *   `id:{data.id};request-id:{x-request-id};ts:{ts};`
 * Any segment whose source value is missing from the request is omitted
 * entirely from the manifest — never replaced with an empty value.
 *
 * Never throws. Malformed input (missing `ts`/`v1`, empty/absent header)
 * returns `false`. Comparison uses `crypto.timingSafeEqual` over
 * equal-length buffers — never `===` on the hex digest (timing attack
 * surface, RESEARCH.md Security Domain table).
 */
export function verifyMpSignature(params: VerifyMpSignatureParams): boolean {
  const { xSignature, xRequestId, dataId, secret } = params;

  if (!xSignature) return false;

  const parts = Object.fromEntries(
    xSignature.split(',').map((segment) => {
      const [key, value] = segment.split('=');
      return [key?.trim(), value?.trim()];
    }),
  );

  const ts = parts['ts'];
  const v1 = parts['v1'];

  if (!ts || !v1) return false;

  let manifest = `id:${dataId};`;
  if (xRequestId) manifest += `request-id:${xRequestId};`;
  manifest += `ts:${ts};`;

  const computed = createHmac('sha256', secret).update(manifest).digest('hex');

  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(v1, 'hex');

  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}
