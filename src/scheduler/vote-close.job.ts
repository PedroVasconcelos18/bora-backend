import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { VotingService } from '../voting/voting.service';

/**
 * Vote-window-close cron (VOTE-05).
 *
 * Sweeps `Evidence` rows still PENDING past their 24h `windowClosesAt` and
 * delegates each one to `VotingService.resolveEvidence`, which atomically
 * resolves the majority/abstention algebra (accepted iff
 * `eligibleVoters >= 2 * explicitNao`) via a conditional `updateMany(where
 * status='PENDING')` inside a `$transaction`. No duplicated resolution logic
 * lives here — this job only finds candidates and counts outcomes.
 *
 * Idempotent: `resolveEvidence` no-ops (`'already-resolved'`) once an
 * evidence is no longer PENDING, and the `where: { status: 'PENDING' }`
 * query here stops returning an evidence the moment it resolves — running
 * this job twice in a row (or twice concurrently) produces the same end
 * state (T-03-13).
 */
@Injectable()
export class VoteCloseJob {
  private readonly logger = new Logger(VoteCloseJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly votingService: VotingService,
  ) {}

  @Cron('*/15 * * * *', { timeZone: 'America/Sao_Paulo' }) // every 15 min, timezone-aware
  async run(): Promise<void> {
    const expired = await this.prisma.evidence.findMany({
      where: { status: 'PENDING', windowClosesAt: { lte: new Date() } },
      select: { id: true },
    });

    let accepted = 0;
    let rejected = 0;

    for (const evidence of expired) {
      const result = await this.votingService.resolveEvidence(evidence.id);
      if (result === 'accepted') accepted++;
      if (result === 'rejected') rejected++;
    }

    this.logger.log(
      `vote-close: found=${expired.length} accepted=${accepted} rejected=${rejected} at=${new Date().toISOString()}`,
    );
  }
}
