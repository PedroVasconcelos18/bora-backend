import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { RankingService } from './ranking.service';
import { PrismaService } from '../prisma/prisma.service';
import { saoPauloDay } from '../common/utils/sao-paulo-day.util';

describe('RankingService (RANK-01/02/03/04)', () => {
  let service: RankingService;
  let prisma: {
    challenge: { findUnique: jest.Mock };
    evidence: { groupBy: jest.Mock };
    participant: { count: jest.Mock };
    invite: { count: jest.Mock };
  };

  const challengeId = 'challenge-1';

  beforeEach(async () => {
    prisma = {
      challenge: { findUnique: jest.fn() },
      evidence: { groupBy: jest.fn() },
      // Item F: prize base = full roster (participants + pending invites).
      participant: { count: jest.fn().mockResolvedValue(0) },
      invite: { count: jest.fn().mockResolvedValue(0) },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [RankingService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(RankingService);
  });

  it('throws NotFoundException when the challenge does not exist', async () => {
    prisma.challenge.findUnique.mockResolvedValueOnce(null);

    await expect(service.getRanking(challengeId)).rejects.toThrow(NotFoundException);
  });

  it('computes validatedDays from ACCEPTED evidence (RANK-01) and the server-computed live prize (RANK-02)', async () => {
    const startsAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

    prisma.challenge.findUnique.mockResolvedValueOnce({
      id: challengeId,
      durationDays: 5,
      collabAmount: 20,
      platformFee: 10,
      startsAt,
      createdAt: startsAt,
      participants: [
        { id: 'p1', user: { name: 'Ana' }, evidences: [] },
        { id: 'p2', user: { name: 'Beto' }, evidences: [] },
      ],
    });
    prisma.evidence.groupBy.mockResolvedValueOnce([{ participantId: 'p1', _count: 3 }]);
    prisma.participant.count.mockResolvedValueOnce(2); // rosterCount
    prisma.invite.count.mockResolvedValueOnce(0); // no pending invites

    const result = await service.getRanking(challengeId);

    // prize = rosterCount(2) * collabAmount(20) - platformFee(10), server-computed, never from the request.
    expect(result.prize).toBe('30.00');
    expect(result.participants.find((p) => p.id === 'p1')?.validatedDays).toBe(3);
    expect(result.participants.find((p) => p.id === 'p2')?.validatedDays).toBe(0);
  });

  it('bases the prize on the full roster (participants + pending invites), NOT just who paid (item F)', async () => {
    const startsAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

    // Only 2 PAID participants are RANKED, but the roster is 3 participants + 1
    // pending invite = 4 → prize = 4*20 - 10 = 70.00 (same base as sala de espera).
    prisma.challenge.findUnique.mockResolvedValueOnce({
      id: challengeId,
      durationDays: 5,
      collabAmount: 20,
      platformFee: 10,
      startsAt,
      createdAt: startsAt,
      participants: [
        { id: 'p1', user: { name: 'Ana' }, evidences: [] },
        { id: 'p2', user: { name: 'Beto' }, evidences: [] },
      ],
    });
    prisma.evidence.groupBy.mockResolvedValueOnce([]);
    prisma.participant.count.mockResolvedValueOnce(3); // includes 1 unpaid participant
    prisma.invite.count.mockResolvedValueOnce(1); // 1 pending invite

    const result = await service.getRanking(challengeId);

    expect(result.prize).toBe('70.00');
    expect(result.participants).toHaveLength(2); // only PAID rows are ranked
  });

  it('orders participants by validatedDays desc (RANK-01), independent of the input order', async () => {
    const startsAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

    prisma.challenge.findUnique.mockResolvedValueOnce({
      id: challengeId,
      durationDays: 5,
      collabAmount: 20,
      platformFee: 10,
      startsAt,
      createdAt: startsAt,
      participants: [
        { id: 'p1', user: { name: 'Ana' }, evidences: [] }, // lower count, listed first
        { id: 'p2', user: { name: 'Beto' }, evidences: [] }, // higher count, listed second
      ],
    });
    prisma.evidence.groupBy.mockResolvedValueOnce([
      { participantId: 'p1', _count: 1 },
      { participantId: 'p2', _count: 4 },
    ]);

    const result = await service.getRanking(challengeId);

    expect(result.participants.map((p) => p.id)).toEqual(['p2', 'p1']);
  });

  it('flags BOTH participants as leaders on a two-way tie at the max validatedDays (RANK-04)', async () => {
    const startsAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

    prisma.challenge.findUnique.mockResolvedValueOnce({
      id: challengeId,
      durationDays: 5,
      collabAmount: 20,
      platformFee: 10,
      startsAt,
      createdAt: startsAt,
      participants: [
        { id: 'p1', user: { name: 'Ana' }, evidences: [] },
        { id: 'p2', user: { name: 'Beto' }, evidences: [] },
        { id: 'p3', user: { name: 'Caio' }, evidences: [] },
      ],
    });
    prisma.evidence.groupBy.mockResolvedValueOnce([
      { participantId: 'p1', _count: 3 },
      { participantId: 'p2', _count: 3 },
      { participantId: 'p3', _count: 1 },
    ]);

    const result = await service.getRanking(challengeId);

    expect(result.participants.find((p) => p.id === 'p1')?.isLeader).toBe(true);
    expect(result.participants.find((p) => p.id === 'p2')?.isLeader).toBe(true);
    expect(result.participants.find((p) => p.id === 'p3')?.isLeader).toBe(false);
    expect([...result.leaders].sort()).toEqual(['Ana', 'Beto']);
  });

  it('renders a past-day still-PENDING evidence as "pending", never "falhou" (Pitfall 2)', async () => {
    const startsAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const day0 = saoPauloDay(startsAt);

    prisma.challenge.findUnique.mockResolvedValueOnce({
      id: challengeId,
      durationDays: 5,
      collabAmount: 20,
      platformFee: 10,
      startsAt,
      createdAt: startsAt,
      participants: [
        {
          id: 'p1',
          user: { name: 'Ana' },
          evidences: [{ evidenceDate: day0, status: 'PENDING' }],
        },
      ],
    });
    prisma.evidence.groupBy.mockResolvedValueOnce([]);

    const result = await service.getRanking(challengeId);

    expect(result.participants[0].streak[0]).toBe('pending');
  });

  it('renders a past day with no evidence as "falhou", today as "hoje", and a future day as "futuro"', async () => {
    const startsAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // day 0 = yesterday (SP)

    prisma.challenge.findUnique.mockResolvedValueOnce({
      id: challengeId,
      durationDays: 3, // day0=yesterday(falhou), day1=today(hoje), day2=tomorrow(futuro)
      collabAmount: 20,
      platformFee: 10,
      startsAt,
      createdAt: startsAt,
      participants: [{ id: 'p1', user: { name: 'Ana' }, evidences: [] }],
    });
    prisma.evidence.groupBy.mockResolvedValueOnce([]);

    const result = await service.getRanking(challengeId);
    const streak = result.participants[0].streak;

    expect(streak[0]).toBe('falhou');
    expect(streak[1]).toBe('hoje');
    expect(streak[2]).toBe('futuro');
  });
});
