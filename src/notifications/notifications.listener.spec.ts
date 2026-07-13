import { Test } from '@nestjs/testing';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';

describe('NotificationsListener (NOTIF-02, D-04/D-06 audience)', () => {
  let listener: NotificationsListener;
  let notifications: { create: jest.Mock; createMany: jest.Mock };
  let prisma: {
    user: { findUnique: jest.Mock };
    challenge: { findUnique: jest.Mock };
    participant: { findUnique: jest.Mock; findMany: jest.Mock; count: jest.Mock };
    evidence: { findUnique: jest.Mock; count: jest.Mock };
  };

  beforeEach(async () => {
    notifications = {
      create: jest.fn().mockResolvedValue(undefined),
      createMany: jest.fn().mockResolvedValue(undefined),
    };

    prisma = {
      user: { findUnique: jest.fn() },
      challenge: { findUnique: jest.fn() },
      participant: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
      evidence: { findUnique: jest.fn(), count: jest.fn() },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsListener,
        { provide: NotificationsService, useValue: notifications },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    listener = moduleRef.get(NotificationsListener);
  });

  describe('invite.sent (tipo 1, INVITE_RECEIVED — pessoal)', () => {
    it('creates nothing, and does not throw, when targetEmail has no User yet (Pitfall 4 — the normal path)', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);

      await expect(
        listener.handleInviteSent({
          inviteId: 'invite-token-1',
          targetEmail: 'ainda-sem-conta@example.com',
          challengeId: 'challenge-1',
        }),
      ).resolves.toBeUndefined();

      expect(notifications.create).not.toHaveBeenCalled();
      expect(prisma.challenge.findUnique).not.toHaveBeenCalled();
    });

    it('creates INVITE_RECEIVED for an existing user, entityId = invite token', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'user-1' });
      prisma.challenge.findUnique.mockResolvedValueOnce({
        title: 'Corrida matinal',
        collabAmount: { toString: () => '25.00' },
        creator: { name: 'Rafa' },
      });

      await listener.handleInviteSent({
        inviteId: 'invite-token-1',
        targetEmail: 'joao@example.com',
        challengeId: 'challenge-1',
      });

      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith({
        userId: 'user-1',
        type: 'INVITE_RECEIVED',
        entityId: 'invite-token-1',
        payload: {
          inviterName: 'Rafa',
          challengeTitle: 'Corrida matinal',
          amount: '25.00',
        },
      });
    });
  });

  describe('payment.confirmed (tipo 2, PAYMENT_CONFIRMED — grupo, incluindo o pagador)', () => {
    it('fans out to every PAID/ACTIVE participant with missingCount = 3 - paidCount', async () => {
      prisma.challenge.findUnique.mockResolvedValueOnce({ title: 'Treino 5x na semana' });
      prisma.participant.findUnique.mockResolvedValueOnce({ user: { name: 'Rafa Costa' } });
      prisma.participant.count.mockResolvedValueOnce(2);
      prisma.participant.findMany.mockResolvedValueOnce([
        { id: 'participant-1', userId: 'user-1' },
        { id: 'participant-2', userId: 'user-2' },
      ]);

      await listener.handlePaymentConfirmed({
        paymentId: 'payment-1',
        participantId: 'participant-1',
        challengeId: 'challenge-1',
      });

      expect(notifications.createMany).toHaveBeenCalledTimes(1);
      const inputs = notifications.createMany.mock.calls[0][0];
      expect(inputs).toHaveLength(2);
      for (const input of inputs) {
        expect(input.type).toBe('PAYMENT_CONFIRMED');
        expect(input.entityId).toBe('payment-1');
        expect(input.payload.missingCount).toBe(1);
        expect(input.payload.payerName).toBe('Rafa Costa');
      }
    });

    it('clamps missingCount to 0 once >=3 are already paid', async () => {
      prisma.challenge.findUnique.mockResolvedValueOnce({ title: 'Treino' });
      prisma.participant.findUnique.mockResolvedValueOnce({ user: { name: 'Rafa' } });
      prisma.participant.count.mockResolvedValueOnce(4);
      prisma.participant.findMany.mockResolvedValueOnce([{ id: 'participant-1', userId: 'user-1' }]);

      await listener.handlePaymentConfirmed({
        paymentId: 'payment-1',
        participantId: 'participant-1',
        challengeId: 'challenge-1',
      });

      const inputs = notifications.createMany.mock.calls[0][0];
      expect(inputs[0].payload.missingCount).toBe(0);
    });
  });

  describe('evidence.submitted (tipo 3, EVIDENCE_SUBMITTED — grupo menos o autor, D-06)', () => {
    it('excludes the author from the fan-out (4 PAID participants, author included, only 3 notified)', async () => {
      prisma.challenge.findUnique.mockResolvedValueOnce({ title: 'Leitura diária' });
      prisma.participant.findUnique.mockResolvedValueOnce({ user: { name: 'Ana' } });
      // the query itself already excludes the author via `id: { not: participantId }` —
      // mirror that here, matching the real Prisma WHERE contract.
      prisma.participant.findMany.mockResolvedValueOnce([
        { id: 'participant-2', userId: 'user-2' },
        { id: 'participant-3', userId: 'user-3' },
        { id: 'participant-4', userId: 'user-4' },
      ]);

      await listener.handleEvidenceSubmitted({
        evidenceId: 'evidence-1',
        participantId: 'participant-1',
        challengeId: 'challenge-1',
      });

      expect(prisma.participant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { not: 'participant-1' } }),
        }),
      );
      expect(notifications.createMany).toHaveBeenCalledTimes(1);
      const inputs = notifications.createMany.mock.calls[0][0];
      expect(inputs).toHaveLength(3);
      expect(inputs.every((i: { type: string }) => i.type === 'EVIDENCE_SUBMITTED')).toBe(true);
      expect(inputs.some((i: { userId: string }) => i.userId === 'user-1')).toBe(false);
    });
  });

  describe('evidence.resolved (tipo 4 EVIDENCE_VALIDATED / tipo 9 EVIDENCE_REJECTED — pessoal)', () => {
    it('accepted: creates exactly 1 EVIDENCE_VALIDATED for the evidence owner, including totalValidatedDays', async () => {
      prisma.challenge.findUnique.mockResolvedValueOnce({ title: 'Corrida' });
      prisma.participant.findUnique.mockResolvedValueOnce({ userId: 'user-1' });
      prisma.evidence.findUnique.mockResolvedValueOnce({ evidenceDate: '2026-07-13' });
      prisma.evidence.count.mockResolvedValueOnce(5);

      await listener.handleEvidenceResolved({
        evidenceId: 'evidence-1',
        participantId: 'participant-1',
        challengeId: 'challenge-1',
        outcome: 'accepted',
      });

      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith({
        userId: 'user-1',
        type: 'EVIDENCE_VALIDATED',
        entityId: 'evidence-1',
        payload: expect.objectContaining({ challengeTitle: 'Corrida', totalValidatedDays: 5 }),
      });
    });

    it('rejected: creates exactly 1 EVIDENCE_REJECTED for the evidence owner, no totalValidatedDays lookup', async () => {
      prisma.challenge.findUnique.mockResolvedValueOnce({ title: 'Corrida' });
      prisma.participant.findUnique.mockResolvedValueOnce({ userId: 'user-1' });
      prisma.evidence.findUnique.mockResolvedValueOnce({ evidenceDate: '2026-07-13' });

      await listener.handleEvidenceResolved({
        evidenceId: 'evidence-1',
        participantId: 'participant-1',
        challengeId: 'challenge-1',
        outcome: 'rejected',
      });

      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith({
        userId: 'user-1',
        type: 'EVIDENCE_REJECTED',
        entityId: 'evidence-1',
        payload: expect.objectContaining({ challengeTitle: 'Corrida' }),
      });
      expect(prisma.evidence.count).not.toHaveBeenCalled();
    });
  });

  describe('evidence.reminder (tipo 5, EVIDENCE_REMINDER — pessoal)', () => {
    it('creates with a composite entityId (participantId:evidenceDate) — idempotent against a re-run cron', async () => {
      prisma.challenge.findUnique.mockResolvedValueOnce({ title: 'Corrida' });

      await listener.handleEvidenceReminder({
        participantId: 'participant-1',
        userId: 'user-1',
        challengeId: 'challenge-1',
        evidenceDate: '2026-07-13',
      });

      expect(notifications.create).toHaveBeenCalledWith({
        userId: 'user-1',
        type: 'EVIDENCE_REMINDER',
        entityId: 'participant-1:2026-07-13',
        payload: { challengeTitle: 'Corrida', challengeId: 'challenge-1' },
      });
    });
  });

  describe('challenge.finalized (tipo 6, CHALLENGE_FINALIZED — grupo)', () => {
    it('fans out to all 3 participants with exactly 1 flagged isCurrentUserWinner', async () => {
      prisma.challenge.findUnique.mockResolvedValueOnce({ title: 'Leitura 20 min por dia' });
      prisma.participant.findUnique.mockResolvedValueOnce({ user: { name: 'Marina' } });
      prisma.participant.findMany.mockResolvedValueOnce([
        { id: 'participant-1', userId: 'user-1' },
        { id: 'participant-2', userId: 'user-2' },
        { id: 'participant-3', userId: 'user-3' },
      ]);

      await listener.handleChallengeFinalized({
        challengeId: 'challenge-1',
        winnerParticipantIds: ['participant-2'],
        prize: '150.00',
      });

      expect(notifications.createMany).toHaveBeenCalledTimes(1);
      const inputs = notifications.createMany.mock.calls[0][0];
      expect(inputs).toHaveLength(3);

      const winners = inputs.filter((i: { payload: { isCurrentUserWinner: boolean } }) => i.payload.isCurrentUserWinner);
      expect(winners).toHaveLength(1);
      expect(winners[0].userId).toBe('user-2');

      for (const input of inputs) {
        expect(input.payload.winnerName).toBe('Marina');
        expect(input.payload.prizeAmount).toBe('150.00');
      }
    });
  });

  describe('challenge.cancelled (tipo 7, CHALLENGE_CANCELLED — grupo)', () => {
    it('fans out with the given reason', async () => {
      prisma.challenge.findUnique.mockResolvedValueOnce({ title: 'Corrida' });
      prisma.participant.findMany.mockResolvedValueOnce([{ id: 'participant-1', userId: 'user-1' }]);

      await listener.handleChallengeCancelled({ challengeId: 'challenge-1', reason: 'deadline' });

      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({
          type: 'CHALLENGE_CANCELLED',
          entityId: 'challenge-1',
          payload: expect.objectContaining({ reason: 'deadline' }),
        }),
      ]);
    });
  });

  describe('challenge.activated (tipo 8, CHALLENGE_ACTIVATED — grupo)', () => {
    it('fans out to the group', async () => {
      prisma.challenge.findUnique.mockResolvedValueOnce({ title: 'Corrida' });
      prisma.participant.findMany.mockResolvedValueOnce([{ id: 'participant-1', userId: 'user-1' }]);

      await listener.handleChallengeActivated({ challengeId: 'challenge-1' });

      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'CHALLENGE_ACTIVATED', entityId: 'challenge-1' }),
      ]);
    });
  });
});
