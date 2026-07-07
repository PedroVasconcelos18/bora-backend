import { Module } from '@nestjs/common';
import { ResendAdapter } from './adapters/resend.adapter';

/**
 * EmailModule binds the 'EMAIL_PROVIDER' token to ResendAdapter.
 *
 * Consumers inject via @Inject('EMAIL_PROVIDER') — never the concrete class.
 * This follows the adapter-isolation convention established for Mercado Pago:
 * switching email providers means swapping the adapter, not callers.
 */
@Module({
  providers: [
    {
      provide: 'EMAIL_PROVIDER',
      useClass: ResendAdapter,
    },
  ],
  exports: ['EMAIL_PROVIDER'],
})
export class EmailModule {}
