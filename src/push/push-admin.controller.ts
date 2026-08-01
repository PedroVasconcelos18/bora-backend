import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';
import { PushSenderService } from './push-sender.service';
import { AdminTestPushDto } from './dto/admin-test-push.dto';
import { saoPauloDay } from '../common/utils/sao-paulo-day.util';

/**
 * POST /admin/push/test — the operator-only manual trigger (Discretion #5).
 *
 * The only test that proves this phase works is a real device with the
 * screen locked (SC-1/SC-5), and waiting for 18h America/Sao_Paulo on every
 * attempt is not a workable UAT loop. This route deliberately bypasses
 * PushListener's coalescing window so the operator sees the push
 * immediately — it goes straight through PushSenderService.
 *
 * Gated by the same env-secret guard the refund queue uses, applied at the
 * class level below, never the user JWT. There is no equivalent control
 * anywhere in the user-facing UI — a "send test" button was explicitly
 * rejected by Discretion #5.
 */
@Controller('admin/push')
@UseGuards(AdminGuard)
export class PushAdminController {
  constructor(private readonly pushSender: PushSenderService) {}

  @Post('test')
  @HttpCode(200)
  async sendTest(
    @Body() dto: AdminTestPushDto,
  ): Promise<{ sent: true; userId: string; evidenceDate: string }> {
    const evidenceDate = saoPauloDay();
    await this.pushSender.sendEvidenceReminder(dto.userId, evidenceDate, dto.challengeIds ?? []);
    return { sent: true, userId: dto.userId, evidenceDate };
  }
}
