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

describe('ChallengesService.removeParticipant (item B)', () => {
  let service: ChallengesService;
  let prisma: {
    challenge: { findUnique: jest.Mock };
    participant: { findUnique: jest.Mock; delete: jest.Mock; count: jest.Mock };
    payment: { deleteMany: jest.Mock };
    invite: { updateMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let paymentsService: { cancelChallenge: jest.Mock };

  const waitingChallenge = { id: 'challenge-1', creatorId: 'creator-1', status: 'WAITING' };
  const unpaidParticipant = {
    id: 'p-2',
    challengeId: 'challenge-1',
    userId: 'user-2',
    status: 'INVITED',
    user: { id: 'user-2', name: 'Amiga', email: 'Amiga@X.com' },
    payments: [],
  };

  beforeEach(async () => {
    const tx = {
      payment: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      participant: { delete: jest.fn().mockResolvedValue({}) },
      invite: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    prisma = {
      challenge: { findUnique: jest.fn().mockResolvedValue(waitingChallenge) },
      participant: {
        findUnique: jest.fn().mockResolvedValue(unpaidParticipant),
        delete: tx.participant.delete,
        count: jest.fn().mockResolvedValue(3),
      },
      payment: { deleteMany: tx.payment.deleteMany },
      invite: { updateMany: tx.invite.updateMany },
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    paymentsService = { cancelChallenge: jest.fn().mockResolvedValue(undefined) };

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

  it('removes an accepted-but-unpaid participant and expires the matching invite when ≥3 remain', async () => {
    const result = await service.removeParticipant('challenge-1', 'p-2', 'creator-1');

    expect(prisma.invite.updateMany).toHaveBeenCalledWith({
      where: { challengeId: 'challenge-1', targetEmail: 'amiga@x.com', status: 'ACCEPTED' },
      data: { status: 'EXPIRED' },
    });
    expect(paymentsService.cancelChallenge).not.toHaveBeenCalled();
    expect(result).toEqual({ removed: true, challengeCancelled: false, remainingParticipants: 3 });
  });

  it('rejects a non-creator caller with ForbiddenException (T-otp-01)', async () => {
    await expect(service.removeParticipant('challenge-1', 'p-2', 'intruder')).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects removal outside WAITING with ConflictException', async () => {
    prisma.challenge.findUnique.mockResolvedValueOnce({ ...waitingChallenge, status: 'ACTIVE' });
    await expect(service.removeParticipant('challenge-1', 'p-2', 'creator-1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('rejects removing a participant from another challenge with NotFoundException (T-otp-02)', async () => {
    prisma.participant.findUnique.mockResolvedValueOnce({
      ...unpaidParticipant,
      challengeId: 'other-challenge',
    });
    await expect(service.removeParticipant('challenge-1', 'p-2', 'creator-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('blocks removing a participant who already paid (PAID status)', async () => {
    prisma.participant.findUnique.mockResolvedValueOnce({ ...unpaidParticipant, status: 'PAID' });
    await expect(service.removeParticipant('challenge-1', 'p-2', 'creator-1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('blocks removing a participant with an APPROVED payment', async () => {
    prisma.participant.findUnique.mockResolvedValueOnce({
      ...unpaidParticipant,
      payments: [{ status: 'APPROVED' }],
    });
    await expect(service.removeParticipant('challenge-1', 'p-2', 'creator-1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('cancels the challenge with a motive when the roster drops below 3', async () => {
    prisma.participant.count.mockResolvedValueOnce(2);

    const result = await service.removeParticipant('challenge-1', 'p-2', 'creator-1');

    expect(paymentsService.cancelChallenge).toHaveBeenCalledWith(
      'challenge-1',
      'manual',
      'A turma ficou com menos de 3 pessoas após a remoção de um participante.',
    );
    expect(result).toEqual({ removed: true, challengeCancelled: true, remainingParticipants: 2 });
  });
});
