import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoAdapter } from './adapters/mercadopago.adapter';
import { FakePixAdapter } from './adapters/fake-pix.adapter';
import { IPaymentProvider } from './interfaces/payment-provider.interface';

const logger = new Logger('PaymentProvider');

/**
 * Selects the IPaymentProvider implementation bound to the
 * 'PAYMENT_PROVIDER' DI token, based on env config.
 *
 * Kept in its own file (not inline in PaymentsModule) so it's testable
 * without NestJS DI metadata — a plain function of ConfigService.
 *
 * THE CRITICAL INVARIANT: PAYMENT_PROVIDER=fake is refused outright when
 * NODE_ENV=production. Real money must never flow through a fake
 * adapter. There is no silent fallback to either provider on a bad or
 * unrecognized config value — every non-happy path throws at boot.
 */
export function createPaymentProvider(config: ConfigService): IPaymentProvider {
  const raw = (config.get<string>('PAYMENT_PROVIDER') ?? 'mercadopago').trim().toLowerCase();
  const nodeEnv = (config.get<string>('NODE_ENV') ?? 'development').trim().toLowerCase();

  if (raw === 'fake') {
    if (nodeEnv === 'production') {
      throw new Error(
        'FATAL: PAYMENT_PROVIDER=fake é proibido com NODE_ENV=production — o FakePixAdapter simula pagamentos aprovados sem dinheiro real. Remova PAYMENT_PROVIDER do ambiente de produção.',
      );
    }

    logger.warn(
      'PaymentProvider: FAKE (dev-only) — cobranças Pix são simuladas, nenhum dinheiro real se move',
    );
    return new FakePixAdapter(config);
  }

  if (raw === 'mercadopago') {
    logger.log('PaymentProvider: MERCADOPAGO');
    return new MercadoPagoAdapter(config);
  }

  throw new Error(
    `PaymentProvider: valor inválido para PAYMENT_PROVIDER="${raw}" — valores aceitos: "mercadopago" | "fake"`,
  );
}
