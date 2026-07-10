import { Controller, Get, HttpCode, Param, Patch, UseGuards } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

/**
 * /admin routes — env-secret gated (AdminGuard, D-11), never the user JWT
 * (T-02-20). Class-level guard mirrors ChallengesController's convention:
 * every route on this controller requires the secret, there are no public
 * admin routes.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  /**
   * GET /admin/refunds — the manual refund queue (PAY-08, D-10): name,
   * amount, and Pix key for every REFUND_PENDING payment.
   */
  @Get('refunds')
  async listRefunds() {
    return this.adminService.listRefunds();
  }

  /**
   * PATCH /admin/refunds/:id — mark a refund done: REFUNDED + refundedAt +
   * logged (D-10, T-02-23).
   */
  @Patch('refunds/:id')
  @HttpCode(200)
  async markRefunded(@Param('id') id: string) {
    return this.adminService.markRefunded(id);
  }

  /**
   * GET /admin/payouts — the manual cash-out queue (PAY-07): winner name,
   * prize amount, and the snapshotted Pix key for every PAYOUT_PENDING
   * payment.
   */
  @Get('payouts')
  async listPayouts() {
    return this.adminService.listPayouts();
  }

  /**
   * PATCH /admin/payouts/:id — mark a payout done: PAID_OUT + paidAt +
   * logged.
   */
  @Patch('payouts/:id')
  @HttpCode(200)
  async markPaidOut(@Param('id') id: string) {
    return this.adminService.markPaidOut(id);
  }
}
