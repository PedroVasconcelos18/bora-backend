import { Test } from '@nestjs/testing';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ChallengesService } from './challenges.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvitesService } from '../invites/invites.service';
import { PaymentsService } from '../payments/payments.service';

describe('ChallengesService.cancel', () => {
  let service: ChallengesService;
  let prisma: { challenge: { findUnique: jest.Mock } };
  let paymentsService: { cancelChallenge: jest.Mock };

  const waitingChallenge = {
    id: 'challenge-1',
    creatorId: 'creator-1',
    status: 'WAITING',
  };

  beforeEach(async () => {
    prisma = {
      challenge: {
        findUnique: jest.fn().mockResolvedValue(waitingChallenge),
      },
    };

    paymentsService = {
      cancelChallenge: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChallengesService,
        { provide: PrismaService, useValue: prisma },
        { provide: InvitesService, useValue: {} },
        { provide: PaymentsService, useValue: paymentsService },
      ],
    }).compile();

    service = moduleRef.get(ChallengesService);
  });

  it('cancels a WAITING challenge when the caller is the creator, delegating to PaymentsService.cancelChallenge (D-09)', async () => {
    const result = await service.cancel('challenge-1', 'creator-1');

    expect(paymentsService.cancelChallenge).toHaveBeenCalledWith('challenge-1', 'manual');
    expect(result).toEqual({ status: 'CANCELLED' });
  });

  it('rejects a non-creator caller with ForbiddenException (T-02-12)', async () => {
    await expect(service.cancel('challenge-1', 'someone-else')).rejects.toThrow(ForbiddenException);
    expect(paymentsService.cancelChallenge).not.toHaveBeenCalled();
  });

  it('rejects a non-WAITING challenge with ConflictException (T-02-13, no cancellation once ACTIVE)', async () => {
    prisma.challenge.findUnique.mockResolvedValueOnce({ ...waitingChallenge, status: 'ACTIVE' });

    await expect(service.cancel('challenge-1', 'creator-1')).rejects.toThrow(ConflictException);
    expect(paymentsService.cancelChallenge).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the challenge does not exist', async () => {
    prisma.challenge.findUnique.mockResolvedValueOnce(null);

    await expect(service.cancel('missing', 'creator-1')).rejects.toThrow(NotFoundException);
    expect(paymentsService.cancelChallenge).not.toHaveBeenCalled();
  });
});

describe('ChallengesService.list', () => {
  let service: ChallengesService;
  let prisma: { challenge: { findMany: jest.Mock } };

  const activeChallengeJoinedAsParticipant = {
    id: 'ch-active',
    title: 'Corrida',
    emoji: '🏃',
    durationDays: 14,
    collabAmount: 35,
    platformFee: 10,
    status: 'ACTIVE',
    creatorId: 'someone-else',
    participants: [
      {
        user: { id: 'participant-1', name: 'Amiga', email: 'a@x.com' },
        status: 'PAID',
      },
    ],
    invites: [],
    createdAt: new Date(),
  };

  beforeEach(async () => {
    prisma = {
      challenge: {
        findMany: jest.fn().mockResolvedValue([activeChallengeJoinedAsParticipant]),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChallengesService,
        { provide: PrismaService, useValue: prisma },
        { provide: InvitesService, useValue: {} },
        { provide: PaymentsService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(ChallengesService);
  });

  it('returns the ACTIVE challenge a non-creator PAID participant joined', async () => {
    const result = await service.list('participant-1');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ch-active');
    expect(result[0].collabAmount).toBe('35');
    expect(result[0].platformFee).toBe('10');
  });

  it('queries prisma with an OR where-clause covering creator and participant membership', async () => {
    await service.list('participant-1');

    expect(prisma.challenge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { creatorId: 'participant-1' },
            { participants: { some: { userId: 'participant-1' } } },
          ],
        },
      }),
    );
  });
});
