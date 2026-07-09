import { ConfigService } from '@nestjs/config';
import { MercadoPagoAdapter } from './mercadopago.adapter';

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
