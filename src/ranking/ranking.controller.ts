import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RankingService } from './ranking.service';

/**
 * No class-level route prefix (mirrors VotingController's shape): the single
 * endpoint lives under the /challenges/:id/... URL family, not /ranking.
 * T-03-17 mitigation: JwtAuthGuard-protected read of the challenge-scoped
 * ranking read model.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class RankingController {
  constructor(private readonly rankingService: RankingService) {}

  /** GET /challenges/:id/ranking — validated days, prize, leaders, streak. */
  @Get('challenges/:id/ranking')
  async getRanking(@Param('id') id: string) {
    return this.rankingService.getRanking(id);
  }
}
