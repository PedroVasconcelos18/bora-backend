import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserPayload } from '../auth/strategies/jwt.strategy';
import { ChallengesService } from './challenges.service';
import { ParticipantsService } from '../participants/participants.service';
import { CreateChallengeDto } from './dto/create-challenge.dto';

@Controller('challenges')
@UseGuards(JwtAuthGuard)
export class ChallengesController {
  constructor(
    private readonly challengesService: ChallengesService,
    private readonly participantsService: ParticipantsService,
  ) {}

  /**
   * POST /challenges — create a new challenge.
   * Creator is the authenticated user (@CurrentUser).
   * Returns the challenge in WAITING with copyable invite links.
   */
  @Post()
  async create(
    @Body() dto: CreateChallengeDto,
    @CurrentUser() user: UserPayload,
  ) {
    return this.challengesService.create(dto, user.id);
  }

  /**
   * GET /challenges — list challenges created by the authenticated user.
   */
  @Get()
  async list(@CurrentUser() user: UserPayload) {
    return this.challengesService.list(user.id);
  }

  /**
   * GET /challenges/:id — get a challenge with its participants and status.
   */
  @Get(':id')
  async get(@Param('id') id: string) {
    const challenge = await this.challengesService.get(id);
    if (!challenge) {
      throw new NotFoundException('Desafio não encontrado.');
    }
    return challenge;
  }

  /**
   * GET /challenges/:id/participants — waiting-room nominal list (CHAL-05,
   * D-13): who paid, who is pending, the live "N de M pagaram", the 3-day
   * deadline, and the live prize (D-03, never cached — pitfall M4).
   */
  @Get(':id/participants')
  async getParticipants(@Param('id') id: string) {
    return this.participantsService.getWaitingRoomStatus(id);
  }

  /**
   * PATCH /challenges/:id/cancel — creator-only, WAITING-only cancellation
   * (D-09). Guards live in ChallengesService.cancel: non-creator ->
   * ForbiddenException (T-02-12), non-WAITING -> ConflictException
   * (T-02-13, no cancellation once ACTIVE).
   */
  @Patch(':id/cancel')
  @HttpCode(200)
  async cancel(@Param('id') id: string, @CurrentUser() user: UserPayload) {
    return this.challengesService.cancel(id, user.id);
  }
}
