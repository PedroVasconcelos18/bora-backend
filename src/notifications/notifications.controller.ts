import { Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserPayload } from '../auth/strategies/jwt.strategy';
import { NotificationsService } from './notifications.service';

/**
 * All 4 endpoints scope every read/write exclusively by the CurrentUser
 * decorator's `.id` (decoded off the JWT) — never a client-supplied userId
 * from body/query/param (T-09-01/02/03/04). The `:id` path param in PATCH
 * identifies the *notification*, not the user; ownership is still enforced
 * server-side inside NotificationsService.markRead.
 *
 * `unread-count` is declared before any future `:id`-shaped route would be
 * added, so the literal segment is never captured by a param matcher.
 */
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  async list(@Query('take') take: string | undefined, @CurrentUser() currentUser: UserPayload) {
    const parsedTake = take !== undefined ? Number(take) : undefined;
    return this.notificationsService.list(
      currentUser.id,
      Number.isFinite(parsedTake) ? parsedTake : undefined,
    );
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() currentUser: UserPayload) {
    const count = await this.notificationsService.unreadCount(currentUser.id);
    return { count };
  }

  @Patch(':id/read')
  @HttpCode(200)
  async markRead(@Param('id') id: string, @CurrentUser() currentUser: UserPayload) {
    await this.notificationsService.markRead(currentUser.id, id);
    return { ok: true };
  }

  @Post('read-all')
  @HttpCode(200)
  async markAllRead(@CurrentUser() currentUser: UserPayload) {
    await this.notificationsService.markAllRead(currentUser.id);
    return { ok: true };
  }
}
