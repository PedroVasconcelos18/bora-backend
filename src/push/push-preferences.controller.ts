import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserPayload } from '../auth/strategies/jwt.strategy';
import { PushPreferencesService } from './push-preferences.service';
import { UpdatePreferenceDto } from './dto/update-preference.dto';

/**
 * T-12-14 mitigation: same access-control shape as `PushController` —
 * JwtAuthGuard-protected at the class level, userId taken only from the
 * verified JWT via @CurrentUser().id, never from the request body/params.
 */
@Controller('push/preferences')
@UseGuards(JwtAuthGuard)
export class PushPreferencesController {
  constructor(private readonly prefs: PushPreferencesService) {}

  /** GET /push/preferences — the caller's 9 resolved per-type preferences. */
  @Get()
  async list(@CurrentUser() user: UserPayload) {
    return this.prefs.listPreferences(user.id);
  }

  /**
   * POST /push/preferences — flips one type on/off, then returns the
   * already-updated full list (instead of void) so the client reconciles
   * with a single round-trip and never ends up with stale state after a
   * partial failure.
   */
  @Post()
  @HttpCode(200)
  async update(@Body() dto: UpdatePreferenceDto, @CurrentUser() user: UserPayload) {
    await this.prefs.setPreference(user.id, dto.type, dto.enabled);
    return this.prefs.listPreferences(user.id);
  }
}
