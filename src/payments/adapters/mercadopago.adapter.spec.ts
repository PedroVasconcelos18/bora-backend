import { ConfigService } from '@nestjs/config';
import { MercadoPagoAdapter } from './mercadopago.adapter';
import { PaymentNotFoundError } from '../errors/payment-not-found.error';

/**
 * GAP 4 — the adapter must resolve and expose a test/live/unconfigured mode
 * from the MERCADOPAGO_ACCESS_TOKEN prefix, without ever logging the token
 * value itself. Only the constructor is under test here; no network calls.
 */
describe('MercadoPagoAdapter mode detection', () => {
  const makeConfig = (token: string) =>
    ({ get: jest.fn().mockReturnValue(token) }) as unknown as ConfigService;

  it('resolves mode "test" for a TEST- prefixed access token', () => {
    const adapter = new MercadoPagoAdapter(makeConfig('TEST-abc123'));

    expect(adapter.mode).toBe('test');
  });

  it('resolves mode "live" for a non-TEST access token (e.g. APP_USR-)', () => {
    const adapter = new MercadoPagoAdapter(makeConfig('APP_USR-abc123'));

    expect(adapter.mode).toBe('live');
  });

  it('resolves mode "unconfigured" for an empty access token', () => {
    const adapter = new MercadoPagoAdapter(makeConfig(''));

    expect(adapter.mode).toBe('unconfigured');
  });
});

/**
 * #2/#3/#4 root cause — the 404 normalization boundary.
 *
 * Every one of the three production symptoms traced back to `getPayment`
 * having no contract for "the provider does not know this id". This block is
 * the single place that contract is enforced; once it holds, neither the cron
 * nor the webhook has to know what a Mercado Pago error looks like.
 *
 * No network: the SDK client's `get` is replaced per-test. The rejection
 * fixtures reproduce the SDK's real behavior — `RestClient.fetch` does
 * `throw await response.json()`, so it rejects with a PLAIN OBJECT, never an
 * Error. A predicate written for `Error` subclasses would silently never match.
 */
describe('MercadoPagoAdapter.getPayment — 404 normalization', () => {
  const makeAdapter = () => {
    const adapter = new MercadoPagoAdapter({
      get: jest.fn().mockReturnValue('TEST-abc123'),
    } as unknown as ConfigService);
    const get = jest.fn();
    // Element access bypasses `private`; no network is ever reached.
    (adapter['payment'] as unknown as { get: jest.Mock }).get = get;
    return { adapter, get };
  };

  /** Verbatim shape from the Railway log, 30/07/2026 18:31:37. */
  const mpNotFound = {
    message: 'Payment not found',
    error: 'not_found',
    status: 404,
    cause: [{ code: 2000 }],
  };

  it('converts the Mercado Pago 404 body into a PaymentNotFoundError carrying the externalId', async () => {
    const { adapter, get } = makeAdapter();
    get.mockRejectedValue(mpNotFound);

    let caught: unknown;
    try {
      await adapter.getPayment('170356446929');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PaymentNotFoundError);
    expect((caught as PaymentNotFoundError).externalId).toBe('170356446929');
  });

  it('serializes the provider payload to a STRING on the error — the raw MP object never crosses the boundary', async () => {
    const { adapter, get } = makeAdapter();
    get.mockRejectedValue(mpNotFound);

    const caught = await adapter.getPayment('170356446929').catch((err: unknown) => err);
    const detail = (caught as PaymentNotFoundError).providerDetail;

    expect(typeof detail).toBe('string');
    // describeError, not String(err): a plain object would stringify to
    // "[object Object]" and the real reason (code 2000) would be lost.
    expect(detail).toContain('2000');
    expect(detail).not.toBe('[object Object]');
  });

  it('tolerates a stringified status — the body is untyped JSON, "404" and 404 are the same answer', async () => {
    const { adapter, get } = makeAdapter();
    get.mockRejectedValue({ message: 'Payment not found', error: 'not_found', status: '404' });

    await expect(adapter.getPayment('ext-1')).rejects.toBeInstanceOf(PaymentNotFoundError);
  });

  it('classifies on the 404 alone, with no error:"not_found" field present', async () => {
    const { adapter, get } = makeAdapter();
    get.mockRejectedValue({ message: 'Payment not found', status: 404 });

    // The HTTP status is the necessary AND sufficient signal. Requiring the
    // `error` string too would make a 404 whose body shape shifts degrade into
    // "transient", resurrecting #3's infinite retry loop.
    await expect(adapter.getPayment('ext-1')).rejects.toBeInstanceOf(PaymentNotFoundError);
  });

  /**
   * REVIEW BLOCKER (hardening cycle) — `error: 'not_found'` is NOT sufficient
   * on its own.
   *
   * The shipped predicate accepted `body.error === 'not_found'` regardless of
   * status, on the speculative rationale that "a transport that omits status
   * still classifies correctly". No captured payload ever backed that leg, and
   * Mercado Pago is widely reported to answer `"error":"not_found"` alongside
   * NON-404 statuses — notably 401 for an invalid/expired/wrong-account token
   * on GET /v1/payments/{id}.
   *
   * The cost is one-way and total. A misclassification makes BOTH consumers
   * destroy money state irreversibly: the sweep writes CANCELLED (the row
   * leaves the `status:'PENDING'` scan forever) and the webhook answers 200 (MP
   * stops redelivering, so the notification is gone). A wrong-token window
   * would mass-cancel every live PENDING charge and silently drop every
   * `approved` that arrived during it, with no recovery once credentials are
   * fixed. Production is running a TEST- token today with a swap to live
   * pending, so this is a live hazard, not a thought experiment.
   *
   * The correct degradation for "cannot classify" is TRANSIENT: the sweep skips
   * and retries next hour, the webhook answers non-200 and MP keeps the
   * notification alive. Noisy, but nothing is destroyed.
   */
  it('a 401 carrying error:"not_found" is NOT a not-found — a bad token must never look like a missing payment', async () => {
    const { adapter, get } = makeAdapter();
    const badToken = { message: 'invalid_token', error: 'not_found', status: 401 };
    get.mockRejectedValue(badToken);

    const caught = await adapter.getPayment('ext-1').catch((err: unknown) => err);

    expect(caught).not.toBeInstanceOf(PaymentNotFoundError);
    expect(caught).toBe(badToken);
  });

  it('a status-less body carrying error:"not_found" is NOT a not-found — unclassifiable degrades to transient', async () => {
    const { adapter, get } = makeAdapter();
    const shapeless = { message: 'Payment not found', error: 'not_found' };
    get.mockRejectedValue(shapeless);

    // Deliberately the SAFE direction. Classifying this as not-found would let
    // any transport-level failure that happens to carry the string permanently
    // cancel a live charge; refusing to classify it costs only a retry.
    const caught = await adapter.getPayment('ext-1').catch((err: unknown) => err);

    expect(caught).not.toBeInstanceOf(PaymentNotFoundError);
    expect(caught).toBe(shapeless);
  });

  it('a 500 carrying error:"not_found" is NOT a not-found either', async () => {
    const { adapter, get } = makeAdapter();
    get.mockRejectedValue({ message: 'internal_error', error: 'not_found', status: 500 });

    await expect(adapter.getPayment('ext-1')).rejects.not.toBeInstanceOf(PaymentNotFoundError);
  });

  it('rethrows a 500 UNTOUCHED — a provider outage must stay transient, never become "not found"', async () => {
    const { adapter, get } = makeAdapter();
    const serverError = { message: 'internal_error', status: 500 };
    get.mockRejectedValue(serverError);

    const caught = await adapter.getPayment('ext-1').catch((err: unknown) => err);

    expect(caught).not.toBeInstanceOf(PaymentNotFoundError);
    expect(caught).toBe(serverError);
  });

  it('rethrows a timeout/abort UNTOUCHED (an Error instance, no status field at all)', async () => {
    const { adapter, get } = makeAdapter();
    const abort = new Error('The operation was aborted');
    get.mockRejectedValue(abort);

    const caught = await adapter.getPayment('ext-1').catch((err: unknown) => err);

    expect(caught).not.toBeInstanceOf(PaymentNotFoundError);
    expect(caught).toBe(abort);
  });

  it('a 401 (bad credentials) is NOT a not-found — it must not let callers cancel payments', async () => {
    const { adapter, get } = makeAdapter();
    get.mockRejectedValue({ message: 'invalid_token', status: 401 });

    await expect(adapter.getPayment('ext-1')).rejects.not.toBeInstanceOf(PaymentNotFoundError);
  });

  it('a 200 body with NO status field throws a plain Error — absence is never encoded as a status string (NIT 10)', async () => {
    const { adapter, get } = makeAdapter();
    get.mockResolvedValue({ external_reference: 'participant-1' });

    const caught = await adapter.getPayment('ext-1').catch((err: unknown) => err);

    // `status: 'unknown'` would have been read as a TERMINAL status by the
    // reconciliation sweep and cancelled the row. Throwing keeps it transient.
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(PaymentNotFoundError);
  });

  it('passes a successful lookup straight through', async () => {
    const { adapter, get } = makeAdapter();
    get.mockResolvedValue({ status: 'approved', external_reference: 'participant-1' });

    await expect(adapter.getPayment('ext-1')).resolves.toEqual({
      status: 'approved',
      externalReference: 'participant-1',
    });
  });

  it('an unconfigured token throws a plain Error, NOT PaymentNotFoundError — a deploy fault must never read as "cancel everything"', async () => {
    const adapter = new MercadoPagoAdapter({
      get: jest.fn().mockReturnValue(''),
    } as unknown as ConfigService);

    const caught = await adapter.getPayment('ext-1').catch((err: unknown) => err);

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(PaymentNotFoundError);
  });
});
