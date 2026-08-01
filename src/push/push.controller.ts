import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserPayload } from '../auth/strategies/jwt.strategy';
import { PushService } from './push.service';
import { CreateSubscriptionDto, UnsubscribeDto } from './dto/create-subscription.dto';

/**
 * T-11-07/08/09 mitigation: JwtAuthGuard-protected, userId taken only from
 * the verified JWT via @CurrentUser().id — never from the request
 * body/params. A subscription must never be readable, writable, or
 * deletable across user boundaries.
 */
@Controller('push')
@UseGuards(JwtAuthGuard)
export class PushController {
  constructor(private readonly pushService: PushService) {}

  /** POST /push/subscriptions — register (or re-point) the caller's device. */
  @Post('subscriptions')
  async subscribe(@Body() dto: CreateSubscriptionDto, @CurrentUser() user: UserPayload) {
    return this.pushService.upsertSubscription(user.id, dto);
  }

  /**
   * POST /push/subscriptions/unsubscribe — a POST-with-body rather than a
   * DELETE: the frontend's shared apiClient.delete helper sends no request
   * body, and the endpoint string is too long to be a path segment.
   * @HttpCode(200) mirrors the POST /notifications/read-all convention.
   */
  @Post('subscriptions/unsubscribe')
  @HttpCode(200)
  async unsubscribe(@Body() dto: UnsubscribeDto, @CurrentUser() user: UserPayload) {
    return this.pushService.deleteSubscription(user.id, dto.endpoint);
  }

  /** GET /push/status — the caller's own preference + endpoint list (SC-6). */
  @Get('status')
  async status(@CurrentUser() user: UserPayload) {
    return this.pushService.getStatus(user.id);
  }
}
