import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserPayload } from '../auth/strategies/jwt.strategy';
import { VotingService } from './voting.service';
import { CastVoteDto } from './dto/cast-vote.dto';

/**
 * No class-level route prefix: spans two URL families
 * (/evidences/:id/votes and /challenges/:id/evidences). Both endpoints
 * resolve the caller's Participant row server-side from @CurrentUser() —
 * never a client-supplied voterId (T-03-08).
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class VotingController {
  constructor(private readonly votingService: VotingService) {}

  /** POST /evidences/:id/votes — cast a Sim/Não vote. */
  @Post('evidences/:id/votes')
  @HttpCode(201)
  async castVote(
    @Param('id') evidenceId: string,
    @Body() dto: CastVoteDto,
    @CurrentUser() currentUser: UserPayload,
  ) {
    await this.votingService.castVote(currentUser.id, evidenceId, dto.value);
    return { success: true };
  }

  /** GET /challenges/:id/evidences — today's votable evidences from other participants. */
  @Get('challenges/:id/evidences')
  async listVotable(@Param('id') challengeId: string, @CurrentUser() currentUser: UserPayload) {
    return this.votingService.listVotableEvidences(currentUser.id, challengeId);
  }
}
