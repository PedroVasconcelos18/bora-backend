import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserPayload } from '../auth/strategies/jwt.strategy';
import { FinalizationService } from './finalization.service';

/**
 * No class-level route prefix (mirrors RankingController's shape): the
 * single endpoint lives under the /challenges/:id/... URL family, not
 * /finalization. T-04-13/T-04-14 mitigation: JwtAuthGuard-protected,
 * caller-scoped read of the authenticated user's own payout status.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class FinalizationController {
  constructor(private readonly finalizationService: FinalizationService) {}

  /** GET /challenges/:id/my-payout — the caller's own payout status+amount, or null. */
  @Get('challenges/:id/my-payout')
  async getMyPayout(@Param('id') id: string, @CurrentUser() user: UserPayload) {
    return this.finalizationService.getMyPayout(id, user.id);
  }
}
