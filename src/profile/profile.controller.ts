import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserPayload } from '../auth/strategies/jwt.strategy';
import { ProfileService } from './profile.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

/**
 * T-04-11/T-04-12/T-i98-01 mitigation: JwtAuthGuard-protected, userId taken
 * only from the verified JWT via @CurrentUser().id — never from the request
 * body/params.
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

  /** GET /profile — the caller's own canonical Pix key (D-1). */
  @Get()
  async getProfile(@CurrentUser() user: UserPayload) {
    return this.profileService.getProfile(user.id);
  }

  /** PATCH /profile — trims and persists the caller's own Pix key (D-4). */
  @Patch()
  async updatePixKey(@Body() dto: UpdateProfileDto, @CurrentUser() user: UserPayload) {
    return this.profileService.updatePixKey(user.id, dto.pixKey);
  }
}
