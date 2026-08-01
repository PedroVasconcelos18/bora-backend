import { Test } from '@nestjs/testing';
import { PushListener } from './push.listener';
import { PushSenderService } from './push-sender.service';

describe('PushListener', () => {
  let listener: PushListener;
  let pushSender: { sendEvidenceReminder: jest.Mock };

  beforeEach(async () => {
    jest.useFakeTimers();
    pushSender = { sendEvidenceReminder: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [PushListener, { provide: PushSenderService, useValue: pushSender }],
    }).compile();

    listener = moduleRef.get(PushListener);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('a single event for one user results in exactly one call with a one-element challenge id list', async () => {
    listener.handleEvidenceReminder({
      participantId: 'p1',
      userId: 'user-1',
      challengeId: 'challenge-1',
      evidenceDate: '2026-08-01',
    });

    await jest.advanceTimersByTimeAsync(2000);

    expect(pushSender.sendEvidenceReminder).toHaveBeenCalledTimes(1);
    expect(pushSender.sendEvidenceReminder).toHaveBeenCalledWith('user-1', '2026-08-01', [
      'challenge-1',
    ]);
  });

  it('three events for the same user and evidenceDate emitted in the same tick result in one call with a three-element list', async () => {
    listener.handleEvidenceReminder({
      participantId: 'p1',
      userId: 'user-1',
      challengeId: 'challenge-1',
      evidenceDate: '2026-08-01',
    });
    listener.handleEvidenceReminder({
      participantId: 'p2',
      userId: 'user-1',
      challengeId: 'challenge-2',
      evidenceDate: '2026-08-01',
    });
    listener.handleEvidenceReminder({
      participantId: 'p3',
      userId: 'user-1',
      challengeId: 'challenge-3',
      evidenceDate: '2026-08-01',
    });

    await jest.advanceTimersByTimeAsync(2000);

    expect(pushSender.sendEvidenceReminder).toHaveBeenCalledTimes(1);
    expect(pushSender.sendEvidenceReminder).toHaveBeenCalledWith('user-1', '2026-08-01', [
      'challenge-1',
      'challenge-2',
      'challenge-3',
    ]);
  });

  it('three events for three different users result in three calls, one per user', async () => {
    listener.handleEvidenceReminder({
      participantId: 'p1',
      userId: 'user-1',
      challengeId: 'challenge-1',
      evidenceDate: '2026-08-01',
    });
    listener.handleEvidenceReminder({
      participantId: 'p2',
      userId: 'user-2',
      challengeId: 'challenge-2',
      evidenceDate: '2026-08-01',
    });
    listener.handleEvidenceReminder({
      participantId: 'p3',
      userId: 'user-3',
      challengeId: 'challenge-3',
      evidenceDate: '2026-08-01',
    });

    await jest.advanceTimersByTimeAsync(2000);

    expect(pushSender.sendEvidenceReminder).toHaveBeenCalledTimes(3);
  });

  it('two events for the same user with different evidenceDate values are not coalesced together', async () => {
    listener.handleEvidenceReminder({
      participantId: 'p1',
      userId: 'user-1',
      challengeId: 'challenge-1',
      evidenceDate: '2026-08-01',
    });
    listener.handleEvidenceReminder({
      participantId: 'p2',
      userId: 'user-1',
      challengeId: 'challenge-2',
      evidenceDate: '2026-08-02',
    });

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
    listener.handleEvidenceReminder({
      participantId: 'p1',
      userId: 'user-1',
      challengeId: 'challenge-1',
      evidenceDate: '2026-08-01',
    });
    await jest.advanceTimersByTimeAsync(2000);
    expect(pushSender.sendEvidenceReminder).toHaveBeenCalledTimes(1);

    listener.handleEvidenceReminder({
      participantId: 'p2',
      userId: 'user-1',
      challengeId: 'challenge-2',
      evidenceDate: '2026-08-01',
    });
    await jest.advanceTimersByTimeAsync(2000);

    expect(pushSender.sendEvidenceReminder).toHaveBeenCalledTimes(2);
    expect(pushSender.sendEvidenceReminder).toHaveBeenLastCalledWith('user-1', '2026-08-01', [
      'challenge-2',
    ]);
  });

  it('resolves without throwing when sendEvidenceReminder rejects', async () => {
    pushSender.sendEvidenceReminder.mockRejectedValue(new Error('boom'));

    expect(() =>
      listener.handleEvidenceReminder({
        participantId: 'p1',
        userId: 'user-1',
        challengeId: 'challenge-1',
        evidenceDate: '2026-08-01',
      }),
    ).not.toThrow();

    await expect(jest.advanceTimersByTimeAsync(2000)).resolves.toBeUndefined();
  });
});
