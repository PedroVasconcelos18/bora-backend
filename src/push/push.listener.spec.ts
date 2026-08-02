import { Test } from '@nestjs/testing';
import { PushListener } from './push.listener';
import { PushSenderService } from './push-sender.service';
import { PushNotificationRow } from './config/push-copy.config';

describe('PushListener', () => {
  let listener: PushListener;
  let pushSender: { sendEvidenceReminder: jest.Mock; sendForNotification: jest.Mock };

  function reminderRow(overrides: Partial<PushNotificationRow> & { userId: string }): PushNotificationRow {
    return {
      id: `notif-${Math.random()}`,
      type: 'EVIDENCE_REMINDER',
      entityId: 'participant-uuid:2026-08-01',
      payload: { evidenceDate: '2026-08-01', challengeId: 'challenge-1' },
      createdAt: new Date('2026-08-01T00:00:00Z'),
      ...overrides,
    };
  }

  beforeEach(async () => {
    jest.useFakeTimers();
    pushSender = {
      sendEvidenceReminder: jest.fn().mockResolvedValue(undefined),
      sendForNotification: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [PushListener, { provide: PushSenderService, useValue: pushSender }],
    }).compile();

    listener = moduleRef.get(PushListener);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('EVIDENCE_REMINDER — window branch', () => {
    it('a single event for one user results in exactly one call with a one-element challenge id list', async () => {
      listener.handleNotificationCreated(
        reminderRow({ userId: 'user-1', payload: { evidenceDate: '2026-08-01', challengeId: 'challenge-1' } }),
      );

      await jest.advanceTimersByTimeAsync(2000);

      expect(pushSender.sendEvidenceReminder).toHaveBeenCalledTimes(1);
      expect(pushSender.sendEvidenceReminder).toHaveBeenCalledWith('user-1', '2026-08-01', [
        'challenge-1',
      ]);
    });

    it('three events for the same user and evidenceDate emitted in the same tick result in one call with a three-element list', async () => {
      listener.handleNotificationCreated(
        reminderRow({ userId: 'user-1', payload: { evidenceDate: '2026-08-01', challengeId: 'challenge-1' } }),
      );
      listener.handleNotificationCreated(
        reminderRow({ userId: 'user-1', payload: { evidenceDate: '2026-08-01', challengeId: 'challenge-2' } }),
      );
      listener.handleNotificationCreated(
        reminderRow({ userId: 'user-1', payload: { evidenceDate: '2026-08-01', challengeId: 'challenge-3' } }),
      );

      await jest.advanceTimersByTimeAsync(2000);

      expect(pushSender.sendEvidenceReminder).toHaveBeenCalledTimes(1);
      expect(pushSender.sendEvidenceReminder).toHaveBeenCalledWith('user-1', '2026-08-01', [
        'challenge-1',
        'challenge-2',
        'challenge-3',
      ]);
    });

    it('three events for three different users result in three calls, one per user', async () => {
      listener.handleNotificationCreated(
        reminderRow({ userId: 'user-1', payload: { evidenceDate: '2026-08-01', challengeId: 'challenge-1' } }),
      );
      listener.handleNotificationCreated(
        reminderRow({ userId: 'user-2', payload: { evidenceDate: '2026-08-01', challengeId: 'challenge-2' } }),
      );
      listener.handleNotificationCreated(
        reminderRow({ userId: 'user-3', payload: { evidenceDate: '2026-08-01', challengeId: 'challenge-3' } }),
      );

      await jest.advanceTimersByTimeAsync(2000);

      expect(pushSender.sendEvidenceReminder).toHaveBeenCalledTimes(3);
    });

    it('two events for the same user with different evidenceDate values are not coalesced together', async () => {
      listener.handleNotificationCreated(
        reminderRow({ userId: 'user-1', payload: { evidenceDate: '2026-08-01', challengeId: 'challenge-1' } }),
      );
      listener.handleNotificationCreated(
        reminderRow({ userId: 'user-1', payload: { evidenceDate: '2026-08-02', challengeId: 'challenge-2' } }),
      );

      await jest.advanceTimersByTimeAsync(2000);

      expect(pushSender.sendEvidenceReminder).toHaveBeenCalledTimes(2);
      expect(pushSender.sendEvidenceReminder).toHaveBeenCalledWith('user-1', '2026-08-01', [
        'challenge-1',
      ]);
      expect(pushSender.sendEvidenceReminder).toHaveBeenCalledWith('user-1', '2026-08-02', [
        'challenge-2',
      ]);
    });

    it('after the window flushes, a later event for the same user starts a fresh window rather than being dropped', async () => {
      listener.handleNotificationCreated(
        reminderRow({ userId: 'user-1', payload: { evidenceDate: '2026-08-01', challengeId: 'challenge-1' } }),
      );
      await jest.advanceTimersByTimeAsync(2000);
      expect(pushSender.sendEvidenceReminder).toHaveBeenCalledTimes(1);

      listener.handleNotificationCreated(
        reminderRow({ userId: 'user-1', payload: { evidenceDate: '2026-08-01', challengeId: 'challenge-2' } }),
      );
      await jest.advanceTimersByTimeAsync(2000);

      expect(pushSender.sendEvidenceReminder).toHaveBeenCalledTimes(2);
      expect(pushSender.sendEvidenceReminder).toHaveBeenLastCalledWith('user-1', '2026-08-01', [
        'challenge-2',
      ]);
    });

    it('resolves without throwing when sendEvidenceReminder rejects', async () => {
      pushSender.sendEvidenceReminder.mockRejectedValue(new Error('boom'));

      expect(() =>
        listener.handleNotificationCreated(
          reminderRow({ userId: 'user-1', payload: { evidenceDate: '2026-08-01', challengeId: 'challenge-1' } }),
        ),
      ).not.toThrow();

      await expect(jest.advanceTimersByTimeAsync(2000)).resolves.toBeUndefined();
    });

    it('still resolves the evidenceDate from entityId when the payload omits it', async () => {
      listener.handleNotificationCreated(
        reminderRow({
          userId: 'user-1',
          entityId: 'participant-uuid:2026-08-03',
          payload: { challengeId: 'challenge-1' },
        }),
      );

      await jest.advanceTimersByTimeAsync(2000);

      expect(pushSender.sendEvidenceReminder).toHaveBeenCalledWith('user-1', '2026-08-03', [
        'challenge-1',
      ]);
    });

    it('an EVIDENCE_REMINDER event never calls sendForNotification — it is the only type whose payload is built by the sender', async () => {
      listener.handleNotificationCreated(
        reminderRow({ userId: 'user-1', payload: { evidenceDate: '2026-08-01', challengeId: 'challenge-1' } }),
      );

      await jest.advanceTimersByTimeAsync(2000);

      expect(pushSender.sendForNotification).not.toHaveBeenCalled();
    });
  });

  describe('every other type — direct branch', () => {
    const directRow: PushNotificationRow = {
      id: 'notif-1',
      userId: 'user-1',
      type: 'CHALLENGE_ACTIVATED',
      entityId: 'challenge-1',
      payload: { challengeTitle: 'Corrida matinal', challengeId: 'challenge-1' },
      createdAt: new Date('2026-08-01T00:00:00Z'),
    };

    it('calls sendForNotification immediately, without advancing any timer', () => {
      listener.handleNotificationCreated(directRow);

      expect(pushSender.sendForNotification).toHaveBeenCalledTimes(1);
      expect(pushSender.sendForNotification).toHaveBeenCalledWith(directRow);
    });

    it('a rejection from sendForNotification does not escape the handler', async () => {
      pushSender.sendForNotification.mockRejectedValue(new Error('buildPayload exploded'));

      expect(() => listener.handleNotificationCreated(directRow)).not.toThrow();

      // Let the microtask queue drain so the .catch() runs.
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
