import { Module } from '@nestjs/common';
import { WebPushAdapter } from './adapters/web-push.adapter';

/**
 * PushModule binds the 'PUSH_PROVIDER' token to WebPushAdapter.
 *
 * Consumers inject via @Inject('PUSH_PROVIDER') — never the concrete class.
 * This follows the adapter-isolation convention established for Mercado
 * Pago and email (Resend): swapping push mechanisms means swapping the
 * adapter, not callers.
 */
@Module({
  providers: [
    {
      provide: 'PUSH_PROVIDER',
      useClass: WebPushAdapter,
    },
  ],
  exports: ['PUSH_PROVIDER'],
})
export class PushModule {}
