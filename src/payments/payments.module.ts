import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { MercadoPagoAdapter } from './adapters/mercadopago.adapter';

/**
 * PaymentsModule binds the 'PAYMENT_PROVIDER' token to MercadoPagoAdapter.
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
      useClass: MercadoPagoAdapter,
    },
  ],
  exports: [PaymentsService, 'PAYMENT_PROVIDER'],
})
export class PaymentsModule {}
