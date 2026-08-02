import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';
import { PushAdminService, AdminPushTestResponse } from './push-admin.service';
import { AdminTestPushDto } from './dto/admin-test-push.dto';

/**
 * POST /admin/push/test — the operator-only manual trigger (Discretion #5),
 * generalized by Quick task 260802-by6 into a per-type preview/send bench
 * for all 9 `NotificationType`s.
 *
 * Two modes, chosen by the body:
 * - `dryRun: true` — renders the lock-screen copy for the requested type(s)
 *   and returns it as JSON, WITHOUT touching a device or the provider
 *   (D-01). This is what lets an operator read all 9 notification bodies
 *   before a push phase ships, without provoking each underlying event.
 * - no `dryRun` — sends for real through the same `PushSenderService` the
 *   production event pipeline uses.
 *
 * The preference bypass this generalization introduces
 * (`{ ignorePreference: true }`, PIT-2) is intentional and scoped
 * ENTIRELY to `PushAdminService` — a test endpoint that silently no-ops
 * because of the operator's own preference setting defeats its purpose.
 * The device-subscription requirement is never bypassed: no
 * `PushSubscription` for the target user still means
 * `skipped_no_subscription`, never a faked success.
 *
 * Gated by the same env-secret guard the refund queue uses, applied at the
 * class level below, never the user JWT. There is no equivalent control
 * anywhere in the user-facing UI — a "send test" button was explicitly
 * rejected by Discretion #5.
 */
@Controller('admin/push')
@UseGuards(AdminGuard)
export class PushAdminController {
  constructor(private readonly pushAdmin: PushAdminService) {}

  @Post('test')
  @HttpCode(200)
  async sendTest(@Body() dto: AdminTestPushDto): Promise<AdminPushTestResponse> {
    return this.pushAdmin.run(dto);
  }
}
