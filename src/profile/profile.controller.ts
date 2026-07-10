import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserPayload } from '../auth/strategies/jwt.strategy';
import { ProfileService } from './profile.service';

/**
 * T-04-11/T-04-12 mitigation: JwtAuthGuard-protected, userId taken only from
 * the verified JWT via @CurrentUser().id — never from the request body/params.
 */
@Controller('profile')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  /** GET /profile/stats — the caller's own activeChallenges + validatedDays. */
  @Get('stats')
  async getStats(@CurrentUser() user: UserPayload) {
    return this.profileService.getStats(user.id);
  }
}
