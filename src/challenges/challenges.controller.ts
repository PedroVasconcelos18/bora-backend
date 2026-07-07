import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserPayload } from '../auth/strategies/jwt.strategy';
import { ChallengesService } from './challenges.service';
import { CreateChallengeDto } from './dto/create-challenge.dto';

@Controller('challenges')
@UseGuards(JwtAuthGuard)
export class ChallengesController {
  constructor(private readonly challengesService: ChallengesService) {}

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
}
