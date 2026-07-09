import { Controller, Get, HttpCode, Param, Post, UseGuards, Body } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserPayload } from '../auth/strategies/jwt.strategy';
import { ParticipantsService } from './participants.service';
import { PayEntryDto } from './dto/pay-entry.dto';

@Controller('participants')
@UseGuards(JwtAuthGuard)
export class ParticipantsController {
  constructor(private readonly participantsService: ParticipantsService) {}

  /**
   * POST /participants/me/pay
   * Creator's "pagar minha entrada" (D-06) — keyed on @CurrentUser() + challengeId
   * from the body, never a client-supplied participant id (T-02-03).
   */
  @Post('me/pay')
  @HttpCode(201)
  async payMyEntry(
    @Body() dto: PayEntryDto,
    @CurrentUser() currentUser: UserPayload,
  ) {
    return this.participantsService.payEntry(currentUser.id, dto.challengeId, dto.pixKey);
  }

  /**
   * GET /participants/:id/payment-status
   * Polling target for the pay screen. Returns 403 if the caller does not
   * own the participant row.
   */
  @Get(':id/payment-status')
  async getPaymentStatus(
    @Param('id') id: string,
    @CurrentUser() currentUser: UserPayload,
  ) {
    return this.participantsService.getPaymentStatus(id, currentUser.id);
  }
}
