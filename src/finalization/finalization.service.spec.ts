import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FinalizationService } from './finalization.service';
import { PrismaService } from '../prisma/prisma.service';
import { RankingService, RankingParticipant, RankingResult } from '../ranking/ranking.service';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeParticipant(overrides: Partial<RankingParticipant>): RankingParticipant {
  return {
    id: 'participant-x',
    name: 'Someone',
    validatedDays: 0,
    durationDays: 3,
    progress: 0,
    isLeader: false,
    streak: [],
    ...overrides,
  };
}

describe('FinalizationService.finalizeIfDone (PAY-06, D-02/D-03/D-04/D-06/D-07)', () => {
  let service: FinalizationService;
  let tx: { $executeRaw: jest.Mock; payment: { create: jest.Mock } };
  let prisma: {
    challenge: { findUnique: jest.Mock };
    evidence: { count: jest.Mock };
    participant: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let rankingService: { getRanking: jest.Mock };
  let eventEmitter: { emit: jest.Mock };

  // A challenge that started 10 days ago with a 3-day duration is well past
  // its last day (SP) regardless of when this test suite runs.
  const doneChallenge = {
    id: 'challenge-1',
    status: 'ACTIVE',
    startsAt: new Date(Date.now() - 10 * DAY_MS),
    durationDays: 3,
  };

  beforeEach(async () => {
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      payment: { create: jest.fn().mockResolvedValue({}) },
    };

    prisma = {
      challenge: { findUnique: jest.fn().mockResolvedValue(doneChallenge) },
      evidence: { count: jest.fn().mockResolvedValue(0) },
      participant: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) => callback(tx)),
    };

    rankingService = { getRanking: jest.fn() };
    eventEmitter = { emit: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        FinalizationService,
        { provide: PrismaService, useValue: prisma },
        { provide: RankingService, useValue: rankingService },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = moduleRef.get(FinalizationService);
  });

  it("returns 'not-done' when the challenge is not ACTIVE or has no startsAt", async () => {
    prisma.challenge.findUnique.mockResolvedValueOnce({ ...doneChallenge, status: 'WAITING' });
    await expect(service.finalizeIfDone('challenge-1')).resolves.toBe('not-done');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns 'not-done' when today (SP) is not yet past the last day", async () => {
    prisma.challenge.findUnique.mockResolvedValueOnce({
      ...doneChallenge,
      startsAt: new Date(), // last day is today or in the future
    });

    await expect(service.finalizeIfDone('challenge-1')).resolves.toBe('not-done');
    expect(prisma.evidence.count).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns 'not-done' when an evidence is still PENDING even though the last day has passed (D-02)", async () => {
    prisma.evidence.count.mockResolvedValueOnce(1);

    const result = await service.finalizeIfDone('challenge-1');

    expect(result).toBe('not-done');
    expect(rankingService.getRanking).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('splits a 3-way tied prize to the exact centavo, remainder cents on the first winner by id (D-07)', async () => {
    const ranking: RankingResult = {
      prize: '100.01',
      leaders: ['B', 'A', 'C'],
      participants: [
        makeParticipant({ id: 'participant-b', name: 'B', validatedDays: 3, isLeader: true }),
        makeParticipant({ id: 'participant-a', name: 'A', validatedDays: 3, isLeader: true }),
        makeParticipant({ id: 'participant-c', name: 'C', validatedDays: 3, isLeader: true }),
        makeParticipant({ id: 'participant-d', name: 'D', validatedDays: 1, isLeader: false }),
      ],
    };
    rankingService.getRanking.mockResolvedValueOnce(ranking);
    prisma.participant.findMany.mockResolvedValueOnce([
      { id: 'participant-a', pixKey: 'a@pix' },
      { id: 'participant-b', pixKey: 'b@pix' },
      { id: 'participant-c', pixKey: 'c@pix' },
    ]);

    const result = await service.finalizeIfDone('challenge-1');

    expect(result).toBe('finalized');
    expect(tx.payment.create).toHaveBeenCalledTimes(3);

    const amounts = tx.payment.create.mock.calls.map((call) => call[0].data.amount as string);
    expect(amounts).toEqual(['33.35', '33.33', '33.33']); // sorted by id ascending a,b,c — remainder on first

    const sum = amounts.reduce((acc, amount) => acc + parseFloat(amount), 0);
    expect(sum.toFixed(2)).toBe('100.01');

    expect(tx.payment.create).toHaveBeenCalledWith({
      data: {
        participantId: 'participant-a',
        challengeId: 'challenge-1',
        amount: '33.35',
        status: 'PAYOUT_PENDING',
        pixKey: 'a@pix',
        externalId: null,
      },
    });
  });

  it('NOTIF-02: emits challenge.finalized once (post-commit) with the winner ids and the exact ranking.prize string', async () => {
    const ranking: RankingResult = {
      prize: '100.01',
      leaders: ['B', 'A', 'C'],
      participants: [
        makeParticipant({ id: 'participant-b', name: 'B', validatedDays: 3, isLeader: true }),
        makeParticipant({ id: 'participant-a', name: 'A', validatedDays: 3, isLeader: true }),
        makeParticipant({ id: 'participant-c', name: 'C', validatedDays: 3, isLeader: true }),
      ],
    };
    rankingService.getRanking.mockResolvedValueOnce(ranking);
    prisma.participant.findMany.mockResolvedValueOnce([
      { id: 'participant-a', pixKey: 'a@pix' },
      { id: 'participant-b', pixKey: 'b@pix' },
      { id: 'participant-c', pixKey: 'c@pix' },
    ]);

    await service.finalizeIfDone('challenge-1');

    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    expect(eventEmitter.emit).toHaveBeenCalledWith('challenge.finalized', {
      challengeId: 'challenge-1',
      winnerParticipantIds: ['participant-a', 'participant-b', 'participant-c'],
      prize: '100.01',
    });
  });

  it('NOTIF-02: the idempotent already-finalized path (finalized === false) emits nothing', async () => {
    rankingService.getRanking.mockResolvedValueOnce({
      prize: '20.00',
      leaders: ['A'],
      participants: [makeParticipant({ id: 'participant-a', name: 'A', validatedDays: 3, isLeader: true })],
    });
    prisma.participant.findMany.mockResolvedValueOnce([{ id: 'participant-a', pixKey: 'a@pix' }]);
    tx.$executeRaw.mockResolvedValueOnce(0); // a concurrent tick already flipped the status

    const result = await service.finalizeIfDone('challenge-1');

    expect(result).toBe('already');
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('splits a two-way tied prize of 90.01 into 45.01 + 45.00 (remainder centavo to first winner by id)', async () => {
    rankingService.getRanking.mockResolvedValueOnce({
      prize: '90.01',
      leaders: ['A', 'B'],
      participants: [
        makeParticipant({ id: 'participant-a', name: 'A', validatedDays: 2, isLeader: true }),
        makeParticipant({ id: 'participant-b', name: 'B', validatedDays: 2, isLeader: true }),
      ],
    });
    prisma.participant.findMany.mockResolvedValueOnce([
      { id: 'participant-a', pixKey: 'a@pix' },
      { id: 'participant-b', pixKey: 'b@pix' },
    ]);

    await service.finalizeIfDone('challenge-1');

    const amounts = tx.payment.create.mock.calls.map((call) => call[0].data.amount as string);
    expect(amounts).toEqual(['45.01', '45.00']);
  });

  it('the all-zero validated-days case makes every PAID participant a leader and splits equally, no funds held (D-06)', async () => {
    rankingService.getRanking.mockResolvedValueOnce({
      prize: '20.00',
      leaders: ['A', 'B'],
      participants: [
        makeParticipant({ id: 'participant-a', name: 'A', validatedDays: 0, isLeader: true }),
        makeParticipant({ id: 'participant-b', name: 'B', validatedDays: 0, isLeader: true }),
      ],
    });
    prisma.participant.findMany.mockResolvedValueOnce([
      { id: 'participant-a', pixKey: 'a@pix' },
      { id: 'participant-b', pixKey: 'b@pix' },
    ]);

    const result = await service.finalizeIfDone('challenge-1');

    expect(result).toBe('finalized');
    const amounts = tx.payment.create.mock.calls.map((call) => call[0].data.amount as string);
    expect(amounts).toEqual(['10.00', '10.00']);
  });

  it("is idempotent: calling finalizeIfDone twice yields exactly one set of PAYOUT_PENDING rows (second call returns 'already', creates none)", async () => {
    rankingService.getRanking.mockResolvedValue({
      prize: '20.00',
      leaders: ['A', 'B'],
      participants: [
        makeParticipant({ id: 'participant-a', name: 'A', validatedDays: 3, isLeader: true }),
        makeParticipant({ id: 'participant-b', name: 'B', validatedDays: 3, isLeader: true }),
      ],
    });
    prisma.participant.findMany.mockResolvedValue([
      { id: 'participant-a', pixKey: 'a@pix' },
      { id: 'participant-b', pixKey: 'b@pix' },
    ]);

    const first = await service.finalizeIfDone('challenge-1');
    expect(first).toBe('finalized');
    expect(tx.payment.create).toHaveBeenCalledTimes(2);

    // Second run: the atomic conditional UPDATE affects zero rows because a
    // prior run (or a concurrent tick) already flipped the status.
    tx.$executeRaw.mockResolvedValueOnce(0);

    const second = await service.finalizeIfDone('challenge-1');
    expect(second).toBe('already');
    // No additional payout rows beyond the first run's two.
    expect(tx.payment.create).toHaveBeenCalledTimes(2);
  });
});
