import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { FinalizationService } from './finalization.service';

/**
 * Finalization sweep cron (PAY-06, D-01).
 *
 * Mirrors VoteCloseJob's structure exactly: finds ACTIVE challenge
 * candidates and delegates each to FinalizationService.finalizeIfDone, which
 * owns all D-02 done-check algebra and the D-03 idempotent atomic transition.
 * This job only finds candidates and counts outcomes — no resolution logic
 * lives here.
 *
 * Idempotent: finalizeIfDone no-ops ('not-done'/'already') for any challenge
 * that isn't truly done yet or was already finalized by a prior tick —
 * running this job twice in a row (or twice concurrently) produces the same
 * end state (mirrors T-03-13 / D-03).
 */
@Injectable()
export class FinalizationJob {
  private readonly logger = new Logger(FinalizationJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly finalizationService: FinalizationService,
  ) {}

  @Cron('*/15 * * * *', { timeZone: 'America/Sao_Paulo' }) // every 15 min, timezone-aware (D-01)
  async run(): Promise<void> {
    const candidates = await this.prisma.challenge.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });

    let finalized = 0;

    for (const challenge of candidates) {
      const result = await this.finalizationService.finalizeIfDone(challenge.id);
      if (result === 'finalized') finalized++;
    }

    this.logger.log(
      `finalization: candidates=${candidates.length} finalized=${finalized} at=${new Date().toISOString()}`,
    );
  }
}
