import { Test } from '@nestjs/testing';
import { PushSenderService } from './push-sender.service';
import { PushService } from './push.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PushSenderService', () => {
  let service: PushSenderService;
  let push: { send: jest.Mock };
  let pushService: { getReminderTargets: jest.Mock; pruneSubscription: jest.Mock };
  let prisma: { challenge: { findUnique: jest.Mock } };

  const oneChallengeTargets = {
    enabled: true,
    subscriptions: [{ id: 'sub-1', endpoint: 'https://push.example/1', p256dh: 'p1', auth: 'a1' }],
  };

  beforeEach(async () => {
    push = { send: jest.fn().mockResolvedValue(undefined) };
    pushService = {
      getReminderTargets: jest.fn().mockResolvedValue(oneChallengeTargets),
      pruneSubscription: jest.fn().mockResolvedValue(undefined),
    };
    prisma = {
      challenge: {
        findUnique: jest.fn().mockResolvedValue({ title: 'Corrida matinal' }),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PushSenderService,
        { provide: 'PUSH_PROVIDER', useValue: push },
        { provide: PushService, useValue: pushService },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(PushSenderService);
  });

  it('with one pending challenge, names the challenge in the body and points the url at its detail route', async () => {
    await service.sendEvidenceReminder('user-1', '2026-08-01', ['challenge-1']);

    expect(push.send).toHaveBeenCalledTimes(1);
    const call = push.send.mock.calls[0][0];
    expect(call.payload.body).toBe('Falta a sua evidência de hoje no Corrida matinal');
    expect(call.payload.url).toBe('/challenges/challenge-1');
    expect(call.payload.title).toBe('📸 Bora');
  });

  it('with three pending challenges, states the count in the body and points the url at /home', async () => {
    pushService.getReminderTargets.mockResolvedValue(oneChallengeTargets);

    await service.sendEvidenceReminder('user-1', '2026-08-01', [
      'challenge-1',
      'challenge-2',
      'challenge-3',
    ]);

    const call = push.send.mock.calls[0][0];
    expect(call.payload.body).toBe('Você tem 3 desafios esperando evidência hoje');
    expect(call.payload.url).toBe('/home');
    expect(prisma.challenge.findUnique).not.toHaveBeenCalled();
  });

  it('sends nothing when the preference is disabled, even though subscription rows exist', async () => {
    pushService.getReminderTargets.mockResolvedValue({
      enabled: false,
      subscriptions: [{ id: 'sub-1', endpoint: 'e', p256dh: 'p', auth: 'a' }],
    });

    await service.sendEvidenceReminder('user-1', '2026-08-01', ['challenge-1']);

    expect(push.send).not.toHaveBeenCalled();
  });

  it('sends nothing when there are no subscription rows', async () => {
    pushService.getReminderTargets.mockResolvedValue({ enabled: true, subscriptions: [] });

    await service.sendEvidenceReminder('user-1', '2026-08-01', ['challenge-1']);

    expect(push.send).not.toHaveBeenCalled();
  });

  it('sends exactly one call per subscription the user has', async () => {
    pushService.getReminderTargets.mockResolvedValue({
      enabled: true,
      subscriptions: [
        { id: 'sub-1', endpoint: 'e1', p256dh: 'p1', auth: 'a1' },
        { id: 'sub-2', endpoint: 'e2', p256dh: 'p2', auth: 'a2' },
      ],
    });

    await service.sendEvidenceReminder('user-1', '2026-08-01', ['challenge-1']);

    expect(push.send).toHaveBeenCalledTimes(2);
  });

  it('deletes the subscription when the send rejects with statusCode 410', async () => {
    const err = Object.assign(new Error('gone'), { statusCode: 410 });
    push.send.mockRejectedValue(err);

    await service.sendEvidenceReminder('user-1', '2026-08-01', ['challenge-1']);

    expect(pushService.pruneSubscription).toHaveBeenCalledWith('sub-1');
  });

  it('deletes the subscription when the send rejects with statusCode 404', async () => {
    const err = Object.assign(new Error('not found'), { statusCode: 404 });
    push.send.mockRejectedValue(err);

    await service.sendEvidenceReminder('user-1', '2026-08-01', ['challenge-1']);

    expect(pushService.pruneSubscription).toHaveBeenCalledWith('sub-1');
  });

  it('logs and deletes nothing when the send rejects with statusCode 500', async () => {
    const err = Object.assign(new Error('server error'), { statusCode: 500 });
    push.send.mockRejectedValue(err);

    await service.sendEvidenceReminder('user-1', '2026-08-01', ['challenge-1']);

    expect(pushService.pruneSubscription).not.toHaveBeenCalled();
  });

  it('does not let one failing subscription stop the remaining subscriptions from being sent', async () => {
    pushService.getReminderTargets.mockResolvedValue({
      enabled: true,
      subscriptions: [
        { id: 'sub-1', endpoint: 'e1', p256dh: 'p1', auth: 'a1' },
        { id: 'sub-2', endpoint: 'e2', p256dh: 'p2', auth: 'a2' },
      ],
    });
    push.send.mockRejectedValueOnce(Object.assign(new Error('boom'), { statusCode: 500 }));
    push.send.mockResolvedValueOnce(undefined);

    await service.sendEvidenceReminder('user-1', '2026-08-01', ['challenge-1']);

    expect(push.send).toHaveBeenCalledTimes(2);
  });

  it('never rejects, whatever the adapter does', async () => {
    push.send.mockRejectedValue(new Error('total failure, no statusCode at all'));

    await expect(
      service.sendEvidenceReminder('user-1', '2026-08-01', ['challenge-1']),
    ).resolves.toBeUndefined();
  });

  it('returns without sending when the single referenced challenge no longer exists', async () => {
    prisma.challenge.findUnique.mockResolvedValue(null);

    await service.sendEvidenceReminder('user-1', '2026-08-01', ['challenge-1']);

    expect(push.send).not.toHaveBeenCalled();
  });
});
