import { Module } from '@nestjs/common';
import { WebPushAdapter } from './adapters/web-push.adapter';
import { PushController } from './push.controller';
import { PushService } from './push.service';

/**
 * PushModule binds the 'PUSH_PROVIDER' token to WebPushAdapter.
 *
 * Consumers inject via @Inject('PUSH_PROVIDER') — never the concrete class.
 * This follows the adapter-isolation convention established for Mercado
 * Pago and email (Resend): swapping push mechanisms means swapping the
 * adapter, not callers.
 *
 * The controller registered below exposes the D-08 subscription/preference
 * endpoints; PushService is exported so the Plan 11-04 listener can inject
 * it directly for getReminderTargets/pruneSubscription without touching
 * Prisma itself.
 */
@Module({
  controllers: [PushController],
  providers: [
    {
      provide: 'PUSH_PROVIDER',
      useClass: WebPushAdapter,
    },
    PushService,
  ],
  exports: ['PUSH_PROVIDER', PushService],
})
export class PushModule {}
