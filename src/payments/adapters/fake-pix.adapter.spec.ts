import { ConfigService } from '@nestjs/config';
import { FakePixAdapter } from './fake-pix.adapter';
import { verifyMpSignature } from '../utils/verify-signature.util';

describe('FakePixAdapter', () => {
  const webhookSecret = 'fake-webhook-secret-fixture';
  let configValues: Record<string, unknown>;
  let config: { get: jest.Mock; getOrThrow: jest.Mock };
  let fetchMock: jest.Mock;

  const buildConfig = () => {
    configValues = {
      FAKE_PIX_APPROVE_DELAY_MS: 8000,
      PORT: 3000,
      FAKE_PIX_WEBHOOK_URL: undefined,
    };

    return {
      get: jest.fn((key: string) => configValues[key]),
      getOrThrow: jest.fn((key: string) => {
        if (key === 'MERCADOPAGO_WEBHOOK_SECRET') return webhookSecret;
        throw new Error(`unexpected getOrThrow(${key})`);
      }),
    };
  };

  beforeEach(() => {
    jest.useFakeTimers();
    config = buildConfig();
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function makeAdapter(): FakePixAdapter {
    return new FakePixAdapter(config as unknown as ConfigService);
  }

  const chargeParams = {
    amount: 25,
    description: 'Entrada — Corrida matinal',
    payerEmail: 'joao@example.com',
    externalReference: 'participant-1',
    expirationMinutes: 30,
    idempotencyKey: 'participant-1-123',
  };

  it('createPixCharge returns a full PixChargeResult shape', async () => {
    const adapter = makeAdapter();

    const result = await adapter.createPixCharge(chargeParams);

    expect(result.externalId).toMatch(/^fake-/);
    expect(result.qrCode).toEqual(expect.any(String));
    expect(result.qrCode.length).toBeGreaterThan(0);
    expect(result.qrCodeBase64.length).toBeGreaterThan(0);
    expect(result.ticketUrl).toContain(result.externalId);
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('getPayment is pending before the delay and approved after it', async () => {
    const adapter = makeAdapter();
    const { externalId } = await adapter.createPixCharge(chargeParams);

    expect(await adapter.getPayment(externalId)).toEqual({
      status: 'pending',
      externalReference: 'participant-1',
    });

    await jest.advanceTimersByTimeAsync(8000);

    expect(await adapter.getPayment(externalId)).toEqual({
      status: 'approved',
      externalReference: 'participant-1',
    });
  });

  it('getPayment for an unknown externalId returns unknown/null and never fabricates approved', async () => {
    const adapter = makeAdapter();

    const result = await adapter.getPayment('fake-does-not-exist');

    expect(result).toEqual({ status: 'unknown', externalReference: null });
  });

  it('POSTs the self-triggered webhook to the configured URL with data.id in the query', async () => {
    const adapter = makeAdapter();
    const { externalId } = await adapter.createPixCharge(chargeParams);

    await jest.advanceTimersByTimeAsync(8000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`http://127.0.0.1:3000/payments/webhook?data.id=${encodeURIComponent(externalId)}`);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
  });

  it('the generated signature passes the real verifyMpSignature (positive) and fails when dataId is tampered (negative)', async () => {
    const adapter = makeAdapter();
    const { externalId } = await adapter.createPixCharge(chargeParams);

    await jest.advanceTimersByTimeAsync(8000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const parsedUrl = new URL(String(url));
    const dataId = parsedUrl.searchParams.get('data.id');
    const xSignature = init.headers['x-signature'];
    const xRequestId = init.headers['x-request-id'];

    expect(dataId).toBe(externalId);

    const valid = verifyMpSignature({
      xSignature,
      xRequestId,
      dataId: dataId as string,
      secret: webhookSecret,
    });
    expect(valid).toBe(true);

    const tampered = verifyMpSignature({
      xSignature,
      xRequestId,
      dataId: `${dataId}-tampered`,
      secret: webhookSecret,
    });
    expect(tampered).toBe(false);
  });

  it('onModuleDestroy clears pending timers so the webhook never fires afterward', async () => {
    const adapter = makeAdapter();
    await adapter.createPixCharge(chargeParams);

    adapter.onModuleDestroy();

    await jest.advanceTimersByTimeAsync(20000);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
