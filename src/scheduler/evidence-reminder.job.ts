import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { saoPauloDay } from '../common/utils/sao-paulo-day.util';

/**
 * Evidence-reminder cron (D-07, NOTIF-02 tipo 5 — the only temporal
 * notification type). Mirrors the other 4 scheduler jobs' shape: finds
 * candidates, emits one event per candidate, logs a one-line summary. No
 * notification logic lives here — the event listener owns interpreting
 * `evidence.reminder` into a row (D-01).
 *
 * Runs daily at 18h America/Sao_Paulo — still time to post before the
 * calendar day flips locally (the real deadline for `evidenceDate`,
 * resolved by `saoPauloDay()`), and the person already knows by then
 * whether they kept the habit today.
 */
@Injectable()
export class EvidenceReminderJob {
  private readonly logger = new Logger(EvidenceReminderJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Cron('0 18 * * *', { timeZone: 'America/Sao_Paulo' })
  async run(): Promise<void> {
    const today = saoPauloDay();

    // Single cross-challenge query: PAID/ACTIVE in an ACTIVE challenge, with
    // no Evidence posted for today (D-07 — only reach people who haven't).
    const missing = await this.prisma.participant.findMany({
      where: {
        status: { in: ['PAID', 'ACTIVE'] },
        challenge: { status: 'ACTIVE' },
        evidences: { none: { evidenceDate: today } },
      },
      select: { id: true, userId: true, challengeId: true },
    });

    for (const p of missing) {
      this.eventEmitter.emit('evidence.reminder', {
        participantId: p.id,
        userId: p.userId,
        challengeId: p.challengeId,
        evidenceDate: today,
      });
    }

    this.logger.log(`evidence-reminder: found=${missing.length} at=${new Date().toISOString()}`);
  }
}
