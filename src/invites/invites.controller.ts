import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserPayload } from '../auth/strategies/jwt.strategy';
import { InvitesService } from './invites.service';
import { AcceptAndPayDto } from './dto/accept-and-pay.dto';
import { UpdateInviteDto } from './dto/update-invite.dto';

@Controller('invites')
export class InvitesController {
  constructor(private readonly invitesService: InvitesService) {}

  /**
   * GET /invites/:token
   * Public — returns invite preview (challenge summary + targetEmail) for a valid PENDING token.
   * 404 for unknown or non-PENDING tokens.
   */
  @Get(':token')
  async getInvite(@Param('token') token: string) {
    return this.invitesService.validate(token);
  }

  /**
   * POST /invites/:token/accept
   * Protected — JwtAuthGuard required.
   * AUTH-05 (D-02): enforces user.email === invite.targetEmail in the service layer.
   * Returns the created Participant on success (status INVITED, paidAt null — D-11).
   */
  @Post(':token/accept')
  @UseGuards(JwtAuthGuard)
  @HttpCode(201)
  async acceptInvite(
    @Param('token') token: string,
    @CurrentUser() currentUser: UserPayload,
  ) {
    return this.invitesService.accept(token, currentUser.id);
  }

  /**
   * POST /invites/:token/accept-and-pay
   * Protected — JwtAuthGuard required.
   * Accepts the invite (same email-binding rule as /accept, AUTH-05) then
   * immediately creates a Pix charge for the new Participant (D-06).
   */
  @Post(':token/accept-and-pay')
  @UseGuards(JwtAuthGuard)
  @HttpCode(201)
  async acceptAndPay(
    @Param('token') token: string,
    @Body() dto: AcceptAndPayDto,
    @CurrentUser() currentUser: UserPayload,
  ) {
    return this.invitesService.acceptAndPay(token, currentUser.id, dto.pixKey);
  }

  /**
   * PATCH /invites/:id — creator edits a pending invite's target email and the
   * invitation is re-dispatched to the new address (feedback QA 5a).
   * Creator-only, PENDING-only (guards in InvitesService).
   * NOTE: :id here is the invite's DB id, not the token.
   */
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async updateInvite(
    @Param('id') id: string,
    @Body() dto: UpdateInviteDto,
    @CurrentUser() currentUser: UserPayload,
  ) {
    return this.invitesService.updateEmail(id, currentUser.id, dto.targetEmail);
  }

  /**
   * DELETE /invites/:id — creator removes a pending invite (feedback QA 5a).
   * Creator-only, PENDING-only. :id is the invite's DB id, not the token.
   */
  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async removeInvite(@Param('id') id: string, @CurrentUser() currentUser: UserPayload) {
    return this.invitesService.remove(id, currentUser.id);
  }
}
