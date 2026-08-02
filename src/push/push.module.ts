import { Module } from '@nestjs/common';
import { WebPushAdapter } from './adapters/web-push.adapter';
import { PushController } from './push.controller';
import { PushPreferencesController } from './push-preferences.controller';
import { PushAdminController } from './push-admin.controller';
import { PushService } from './push.service';
import { PushPreferencesService } from './push-preferences.service';
import { PushSenderService } from './push-sender.service';
import { PushAdminService } from './push-admin.service';
import { PushListener } from './push.listener';
import { AdminGuard } from '../admin/admin.guard';

/**
 * PushModule binds the 'PUSH_PROVIDER' token to WebPushAdapter.
 *
 * Consumers inject via @Inject('PUSH_PROVIDER') — never the concrete class.
 * This follows the adapter-isolation convention established for Mercado
 * Pago and email (Resend): swapping push mechanisms means swapping the
 * adapter, not callers.
 *
 * The subscription endpoints stay on `PushController`; the per-type
 * preference endpoints (Plan 12-04: `GET`/`POST /push/preferences`) live on
 * the sibling `PushPreferencesController` registered alongside it; the
 * admin-only manual-trigger route lives on a third controller
 * (Discretion #5), backed by `PushAdminService` (Quick task 260802-by6,
 * generalizing the trigger into a per-type preview/send bench — not
 * exported, nothing outside this module needs it). PushSenderService and
 * the event listener registered below are the Plan 11-04 pair that turns
 * `evidence.reminder` into an actual send — the listener needs no export,
 * like the in-app listener it is discovered automatically by the
 * event-emitter's provider scan. The guard is registered here too
 * because Nest resolves a class-referenced guard from the host module's own
 * injector, and it otherwise only lives in AdminModule. PushService remains
 * exported alongside 'PUSH_PROVIDER' as earlier plans left it;
 * PushPreferencesService is not exported — nothing outside this module
 * needs it.
 */
@Module({
  controllers: [PushController, PushPreferencesController, PushAdminController],
  providers: [
    {
      provide: 'PUSH_PROVIDER',
      useClass: WebPushAdapter,
    },
    PushService,
    PushPreferencesService,
    PushSenderService,
    PushAdminService,
    PushListener,
    AdminGuard,
  ],
  exports: ['PUSH_PROVIDER', PushService],
})
export class PushModule {}
