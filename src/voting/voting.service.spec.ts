import { Test } from '@nestjs/testing';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { VotingService } from './voting.service';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client.js';

describe('VotingService (VOTE-01/02/03/04, D-05)', () => {
  let service: VotingService;
  let eventEmitter: { emit: jest.Mock };
  let prisma: {
    evidence: { findUnique: jest.Mock; updateMany: jest.Mock };
    participant: { findUnique: jest.Mock; count: jest.Mock };
    vote: { create: jest.Mock; count: jest.Mock };
    $transaction: jest.Mock;
  };

  const challengeId = 'challenge-1';
  const evidenceId = 'evidence-1';
  const userId = 'user-2';

  const authorParticipant = { id: 'participant-author', challengeId, userId: 'user-1', status: 'PAID' };
  const voterParticipant = { id: 'participant-voter', challengeId, userId, status: 'PAID' };

  const openEvidence = {
    id: evidenceId,
    challengeId,
    participantId: authorParticipant.id,
    status: 'PENDING',
    windowClosesAt: new Date(Date.now() + 60 * 60 * 1000), // still 1h open
  };

  beforeEach(async () => {
    eventEmitter = { emit: jest.fn() };

    prisma = {
      evidence: {
        findUnique: jest.fn().mockResolvedValue(openEvidence),
        updateMany: jest.fn(),
      },
      participant: {
        findUnique: jest.fn().mockResolvedValue(voterParticipant),
        count: jest.fn(),
      },
      vote: {
        create: jest.fn().mockResolvedValue({}),
        count: jest.fn(),
      },
      // resolveEvidence re-reads through the tx client — mirror it back onto
      // the same mocked prisma object, same shape as payments.service.spec.ts.
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VotingService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = moduleRef.get(VotingService);
  });

  describe('castVote', () => {
    it('throws ForbiddenException when the voter is the evidence author (VOTE-04)', async () => {
      prisma.participant.findUnique.mockResolvedValueOnce(authorParticipant);

      await expect(
        service.castVote(authorParticipant.userId, evidenceId, 'SIM'),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.vote.create).not.toHaveBeenCalled();
    });

    it('throws ConflictException when the evidence window is already closed', async () => {
      prisma.evidence.findUnique.mockResolvedValueOnce({
        ...openEvidence,
        windowClosesAt: new Date(Date.now() - 1000),
      });

      await expect(service.castVote(userId, evidenceId, 'SIM')).rejects.toThrow(ConflictException);
      expect(prisma.vote.create).not.toHaveBeenCalled();
    });

    it('throws ConflictException when the evidence is no longer PENDING', async () => {
      prisma.evidence.findUnique.mockResolvedValueOnce({ ...openEvidence, status: 'ACCEPTED' });

      await expect(service.castVote(userId, evidenceId, 'SIM')).rejects.toThrow(ConflictException);
      expect(prisma.vote.create).not.toHaveBeenCalled();
    });

    it('surfaces a re-vote (duplicate [evidenceId, voterId]) as ConflictException — vote.create is called for the first vote only (VOTE-01)', async () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`evidence_id`,`voter_id`)',
        { code: 'P2002', clientVersion: '7.8.0' },
      );

      await service.castVote(userId, evidenceId, 'SIM');
      expect(prisma.vote.create).toHaveBeenCalledTimes(1);

      prisma.vote.create.mockRejectedValueOnce(p2002);
      await expect(service.castVote(userId, evidenceId, 'SIM')).rejects.toThrow(ConflictException);
      expect(prisma.vote.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('resolveEvidence', () => {
    const pendingEvidence = { ...openEvidence, status: 'PENDING' };

    it('accepts when eligibleVoters >= 2 * explicitNao (3 >= 2*1 — empate=válida, abstenção=sim)', async () => {
      prisma.evidence.findUnique.mockResolvedValueOnce(pendingEvidence);
      prisma.participant.count.mockResolvedValueOnce(3);
      prisma.vote.count.mockResolvedValueOnce(1);
      prisma.evidence.updateMany.mockResolvedValueOnce({ count: 1 });

      const result = await service.resolveEvidence(evidenceId);

      expect(result).toBe('accepted');
      expect(prisma.evidence.updateMany).toHaveBeenCalledWith({
        where: { id: evidenceId, status: 'PENDING' },
        data: { status: 'ACCEPTED', resolvedAt: expect.any(Date) },
      });
    });

    it('NOTIF-02: emits evidence.resolved with outcome="accepted", post-commit', async () => {
      prisma.evidence.findUnique.mockResolvedValueOnce(pendingEvidence);
      prisma.participant.count.mockResolvedValueOnce(3);
      prisma.vote.count.mockResolvedValueOnce(1);
      prisma.evidence.updateMany.mockResolvedValueOnce({ count: 1 });

      await service.resolveEvidence(evidenceId);

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith('evidence.resolved', {
        evidenceId,
        participantId: pendingEvidence.participantId,
        challengeId: pendingEvidence.challengeId,
        outcome: 'accepted',
      });
    });

    it('rejects when eligibleVoters < 2 * explicitNao (2 < 2*2)', async () => {
      prisma.evidence.findUnique.mockResolvedValueOnce(pendingEvidence);
      prisma.participant.count.mockResolvedValueOnce(2);
      prisma.vote.count.mockResolvedValueOnce(2);
      prisma.evidence.updateMany.mockResolvedValueOnce({ count: 1 });

      const result = await service.resolveEvidence(evidenceId);

      expect(result).toBe('rejected');
      expect(prisma.evidence.updateMany).toHaveBeenCalledWith({
        where: { id: evidenceId, status: 'PENDING' },
        data: { status: 'REJECTED', resolvedAt: expect.any(Date) },
      });
    });

    it('NOTIF-02: emits evidence.resolved with outcome="rejected"', async () => {
      prisma.evidence.findUnique.mockResolvedValueOnce(pendingEvidence);
      prisma.participant.count.mockResolvedValueOnce(2);
      prisma.vote.count.mockResolvedValueOnce(2);
      prisma.evidence.updateMany.mockResolvedValueOnce({ count: 1 });

      await service.resolveEvidence(evidenceId);

      expect(eventEmitter.emit).toHaveBeenCalledWith('evidence.resolved', expect.objectContaining({
        outcome: 'rejected',
      }));
    });

    it('is idempotent: resolving an already-resolved evidence a second time returns already-resolved and does not re-write', async () => {
      prisma.evidence.findUnique.mockResolvedValueOnce(pendingEvidence);
      prisma.participant.count.mockResolvedValueOnce(3);
      prisma.vote.count.mockResolvedValueOnce(1);
      prisma.evidence.updateMany.mockResolvedValueOnce({ count: 1 });

      const first = await service.resolveEvidence(evidenceId);
      expect(first).toBe('accepted');

      prisma.evidence.findUnique.mockResolvedValueOnce({ ...pendingEvidence, status: 'ACCEPTED' });
      const second = await service.resolveEvidence(evidenceId);

      expect(second).toBe('already-resolved');
      expect(prisma.evidence.updateMany).toHaveBeenCalledTimes(1);
    });

    it('NOTIF-02: an already-resolved outcome (race with another cron tick) emits nothing', async () => {
      prisma.evidence.findUnique.mockResolvedValueOnce({ ...pendingEvidence, status: 'ACCEPTED' });

      const result = await service.resolveEvidence(evidenceId);

      expect(result).toBe('already-resolved');
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('ROLLBACK-SAFETY (V1): if the $transaction rejects, emit is never called', async () => {
      prisma.$transaction.mockRejectedValueOnce(new Error('transaction rolled back'));

      await expect(service.resolveEvidence(evidenceId)).rejects.toThrow('transaction rolled back');
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
