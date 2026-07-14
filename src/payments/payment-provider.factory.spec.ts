import { ConfigService } from '@nestjs/config';
import { createPaymentProvider } from './payment-provider.factory';
import { MercadoPagoAdapter } from './adapters/mercadopago.adapter';
import { FakePixAdapter } from './adapters/fake-pix.adapter';

describe('createPaymentProvider', () => {
  const webhookSecret = 'factory-webhook-secret-fixture';

  function makeConfig(env: Record<string, string | undefined>) {
    return {
      get: jest.fn((key: string) => env[key]),
      getOrThrow: jest.fn((key: string) => {
        if (key === 'MERCADOPAGO_WEBHOOK_SECRET') return webhookSecret;
        throw new Error(`unexpected getOrThrow(${key})`);
      }),
    } as unknown as ConfigService;
  }

  it('defaults to MercadoPagoAdapter when PAYMENT_PROVIDER is unset', () => {
    const config = makeConfig({});

    const provider = createPaymentProvider(config);

    expect(provider).toBeInstanceOf(MercadoPagoAdapter);
  });

  it('returns MercadoPagoAdapter when PAYMENT_PROVIDER="mercadopago" explicitly', () => {
    const config = makeConfig({ PAYMENT_PROVIDER: 'mercadopago' });

    const provider = createPaymentProvider(config);

    expect(provider).toBeInstanceOf(MercadoPagoAdapter);
  });

  it('returns FakePixAdapter when PAYMENT_PROVIDER="fake" and NODE_ENV="development"', () => {
    const config = makeConfig({ PAYMENT_PROVIDER: 'fake', NODE_ENV: 'development' });

    const provider = createPaymentProvider(config);

    expect(provider).toBeInstanceOf(FakePixAdapter);
  });

  it('returns FakePixAdapter when PAYMENT_PROVIDER="fake" and NODE_ENV="test"', () => {
    const config = makeConfig({ PAYMENT_PROVIDER: 'fake', NODE_ENV: 'test' });

    const provider = createPaymentProvider(config);

    expect(provider).toBeInstanceOf(FakePixAdapter);
  });

  it('THROWS and never returns a provider when PAYMENT_PROVIDER="fake" and NODE_ENV="production"', () => {
    const config = makeConfig({ PAYMENT_PROVIDER: 'fake', NODE_ENV: 'production' });

    expect(() => createPaymentProvider(config)).toThrow(/production/i);
  });

  it('THROWS for PAYMENT_PROVIDER="FAKE" (uppercase) + NODE_ENV="production" (normalization)', () => {
    const config = makeConfig({ PAYMENT_PROVIDER: 'FAKE', NODE_ENV: 'production' });

    expect(() => createPaymentProvider(config)).toThrow(/production/i);
  });

  it('THROWS for an unknown PAYMENT_PROVIDER value', () => {
    const config = makeConfig({ PAYMENT_PROVIDER: 'stripe' });

    expect(() => createPaymentProvider(config)).toThrow(/stripe/i);
  });
});
