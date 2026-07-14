import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { createPaymentProvider } from './payment-provider.factory';

/**
 * PaymentsModule binds the 'PAYMENT_PROVIDER' token via createPaymentProvider,
 * which selects MercadoPagoAdapter (default / PAYMENT_PROVIDER=mercadopago)
 * or FakePixAdapter (PAYMENT_PROVIDER=fake, dev-only) based on env config.
 * The factory throws at boot if PAYMENT_PROVIDER=fake with NODE_ENV=production
 * — real money must never flow through a fake adapter — and throws on any
 * unrecognized PAYMENT_PROVIDER value, with no silent fallback.
 *
 * Consumers inject via @Inject('PAYMENT_PROVIDER') — never the concrete class.
 * Swapping PSPs (Asaas, Stark Bank) means writing a new adapter, not touching
 * PaymentsService (PAY-05 / D-14).
 *
 * PaymentsController carries the public POST /payments/webhook route —
 * deliberately unguarded (Mercado Pago calls it, not a logged-in user).
 */
@Module({
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    {
      provide: 'PAYMENT_PROVIDER',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createPaymentProvider(config),
    },
  ],
  exports: [PaymentsService, 'PAYMENT_PROVIDER'],
})
export class PaymentsModule {}
