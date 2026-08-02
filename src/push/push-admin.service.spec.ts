import { Test } from '@nestjs/testing';
import { PushAdminService } from './push-admin.service';
import { PushSenderService } from './push-sender.service';
import { PushService } from './push.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminTestPushDto } from './dto/admin-test-push.dto';
import { PUSH_CONFIG_BY_TYPE } from './config/push-copy.config';
import { EVIDENCE_REMINDER_PREVIEW, PUSH_PREVIEW_FIXTURES } from './config/push-preview.fixtures';

function dto(partial: Partial<AdminTestPushDto> & { userId: string }): AdminTestPushDto {
  return partial as AdminTestPushDto;
}

const oneSubscription = [{ id: 'sub-1', endpoint: 'e', p256dh: 'p', auth: 'a' }];

describe('PushAdminService (Quick task 260802-by6)', () => {
  let service: PushAdminService;
  let pushSender: {
    sendForNotification: jest.Mock;
    sendEvidenceReminder: jest.Mock;
    buildEvidenceReminderPayload: jest.Mock;
  };
  let pushService: { getPushTargets: jest.Mock };
  let prisma: { notification: { count: jest.Mock } };

  beforeEach(async () => {
    pushSender = {
      sendForNotification: jest.fn().mockResolvedValue(undefined),
      sendEvidenceReminder: jest.fn().mockResolvedValue(undefined),
      buildEvidenceReminderPayload: jest
        .fn()
        .mockImplementation(async (evidenceDate: string, ids: string[]) => {
          if (ids.length === 1) {
            return {
              title: '📸 Bora',
              body: 'Falta a sua evidência de hoje no Corrida matinal',
              url: `/challenges/${ids[0]}`,
              tag: `evidence-reminder-${evidenceDate}`,
            };
          }
          return {
            title: '📸 Bora',
            body: `Você tem ${ids.length} desafios esperando evidência hoje`,
            url: '/home',
            tag: `evidence-reminder-${evidenceDate}`,
          };
        }),
    };
    pushService = {
      getPushTargets: jest.fn().mockResolvedValue({ enabled: true, subscriptions: oneSubscription }),
    };
    prisma = {
      notification: { count: jest.fn().mockResolvedValue(0) },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PushAdminService,
        { provide: PushSenderService, useValue: pushSender },
        { provide: PushService, useValue: pushService },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(PushAdminService);
  });

  describe('dry-run', () => {
    it('previews a simple type (INVITE_RECEIVED) with fully-populated copy and never sends', async () => {
      const result = await service.run(dto({ userId: 'user-1', type: 'INVITE_RECEIVED', dryRun: true }));

      expect(result.dryRun).toBe(true);
      expect(result.results).toHaveLength(1);
      const [entry] = result.results;
      expect(entry.status).toBe('previewed');
      expect(entry.previews).toHaveLength(1);
      const [preview] = entry.previews!;
      expect(preview.title).toBeTruthy();
      expect(preview.body).toBeTruthy();
      expect(preview.body).not.toMatch(/undefined|null/);
      expect(preview.url).toBeTruthy();
      expect(preview.tag).toBeTruthy();
      expect(pushSender.sendForNotification).not.toHaveBeenCalled();
      expect(pushSender.sendEvidenceReminder).not.toHaveBeenCalled();
    });

    it('renders CHALLENGE_FINALIZED in two variants — vencedor and nao-vencedor — with different bodies and tags (QT-04)', async () => {
      const result = await service.run(
        dto({ userId: 'user-1', type: 'CHALLENGE_FINALIZED', dryRun: true }),
      );

      const [entry] = result.results;
      expect(entry.previews).toHaveLength(2);
      const [vencedor, naoVencedor] = entry.previews!;
      expect(vencedor.variant).toBe('vencedor');
      expect(naoVencedor.variant).toBe('nao-vencedor');
      expect(vencedor.body).not.toBe(naoVencedor.body);
      expect(vencedor.tag).not.toBe(naoVencedor.tag);
    });

    it('renders EVIDENCE_REMINDER as two previews via buildEvidenceReminderPayload, without throwing (PIT-1)', async () => {
      const result = await service.run(
        dto({ userId: 'user-1', type: 'EVIDENCE_REMINDER', dryRun: true }),
      );

      const [entry] = result.results;
      expect(entry.status).toBe('previewed');
      expect(entry.previews).toHaveLength(2);
      expect(entry.previews!.map((p) => p.variant)).toEqual(['um-desafio', 'varios-desafios']);
      expect(pushSender.buildEvidenceReminderPayload).toHaveBeenCalledTimes(2);
      expect(pushSender.buildEvidenceReminderPayload).toHaveBeenCalledWith(
        expect.any(String),
        EVIDENCE_REMINDER_PREVIEW.singleChallengeIds,
        { fallbackTitle: EVIDENCE_REMINDER_PREVIEW.fallbackTitle },
      );
      expect(pushSender.buildEvidenceReminderPayload).toHaveBeenCalledWith(
        expect.any(String),
        EVIDENCE_REMINDER_PREVIEW.multiChallengeIds,
      );
    });

    it('runs the real EVIDENCE_SUBMITTED buildPayload with the mocked Prisma count and renders the singular copy (PIT-3)', async () => {
      prisma.notification.count.mockResolvedValueOnce(0);

      const result = await service.run(
        dto({ userId: 'user-1', type: 'EVIDENCE_SUBMITTED', dryRun: true }),
      );

      const [entry] = result.results;
      expect(entry.previews).toHaveLength(1);
      const [preview] = entry.previews!;
      expect(preview.body).toBe('Nova evidência esperando seu voto no Corrida matinal');
      expect(preview.url).toMatch(/\?panel=votar$/);
      expect(
        (PUSH_PREVIEW_FIXTURES.EVIDENCE_SUBMITTED[0].row.payload as Record<string, unknown>)
          .challengeId,
      ).toBeTruthy();
    });

    it('renders every NotificationType with type ALL, in PUSH_CONFIG_BY_TYPE key order, each with at least one preview', async () => {
      const result = await service.run(dto({ userId: 'user-1', type: 'ALL', dryRun: true }));

      const expectedTypes = Object.keys(PUSH_CONFIG_BY_TYPE);
      expect(result.results).toHaveLength(expectedTypes.length);
      expect(result.results.map((r) => r.type)).toEqual(expectedTypes);
      for (const entry of result.results) {
        expect(entry.status).toBe('previewed');
        expect(entry.previews!.length).toBeGreaterThan(0);
      }
    });

    it('when one type\'s buildPayload rejects, that type becomes status error and the rest of ALL still renders', async () => {
      const spy = jest
        .spyOn(PUSH_CONFIG_BY_TYPE.INVITE_RECEIVED, 'buildPayload')
        .mockImplementation(() => {
          throw new Error('boom');
        });

      try {
        const result = await service.run(dto({ userId: 'user-1', type: 'ALL', dryRun: true }));

        const inviteResult = result.results.find((r) => r.type === 'INVITE_RECEIVED')!;
        expect(inviteResult.status).toBe('error');
        expect(inviteResult.error).toBe('boom');

        const others = result.results.filter((r) => r.type !== 'INVITE_RECEIVED');
        expect(others.every((r) => r.status === 'previewed')).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('real send', () => {
    it('CHALLENGE_ACTIVATED passes { ignorePreference: true } to both getPushTargets and sendForNotification (PIT-2)', async () => {
      const result = await service.run(dto({ userId: 'user-1', type: 'CHALLENGE_ACTIVATED' }));

      expect(pushService.getPushTargets).toHaveBeenCalledWith('user-1', 'CHALLENGE_ACTIVATED', {
        ignorePreference: true,
      });
      expect(pushSender.sendForNotification).toHaveBeenCalledWith(
        PUSH_PREVIEW_FIXTURES.CHALLENGE_ACTIVATED[0].row,
        { ignorePreference: true },
      );
      expect(result.results[0]).toMatchObject({ status: 'sent', subscriptions: 1 });
    });

    it('with zero subscriptions, reports skipped_no_subscription and never calls sendForNotification (PIT-2)', async () => {
      pushService.getPushTargets.mockResolvedValue({ enabled: false, subscriptions: [] });

      const result = await service.run(dto({ userId: 'user-1', type: 'CHALLENGE_ACTIVATED' }));

      expect(result.results[0]).toEqual({
        type: 'CHALLENGE_ACTIVATED',
        status: 'skipped_no_subscription',
        subscriptions: 0,
      });
      expect(pushSender.sendForNotification).not.toHaveBeenCalled();
    });

    it('EVIDENCE_REMINDER routes through sendEvidenceReminder, never sendForNotification, with { ignorePreference: true } (PIT-1)', async () => {
      await service.run(dto({ userId: 'user-1', type: 'EVIDENCE_REMINDER' }));

      expect(pushSender.sendEvidenceReminder).toHaveBeenCalledWith(
        'user-1',
        expect.any(String),
        expect.any(Array),
        { ignorePreference: true },
      );
      expect(pushSender.sendForNotification).not.toHaveBeenCalled();
    });

    it('EVIDENCE_REMINDER with challengeIds in the dto repasses exactly those ids (QT-01 legacy caller)', async () => {
      await service.run(dto({ userId: 'user-1', challengeIds: ['c1'] }));

      expect(pushSender.sendEvidenceReminder).toHaveBeenCalledWith(
        'user-1',
        expect.any(String),
        ['c1'],
        { ignorePreference: true },
      );
    });

    it('EVIDENCE_REMINDER without challengeIds uses the synthetic multiChallengeIds and notes it', async () => {
      const result = await service.run(dto({ userId: 'user-1' }));

      expect(pushSender.sendEvidenceReminder).toHaveBeenCalledWith(
        'user-1',
        expect.any(String),
        EVIDENCE_REMINDER_PREVIEW.multiChallengeIds,
        { ignorePreference: true },
      );
      expect(result.results[0].note).toBeDefined();
    });

    it('CHALLENGE_FINALIZED dispatches both variants (two sendForNotification calls) with distinct entityId (QT-04)', async () => {
      await service.run(dto({ userId: 'user-1', type: 'CHALLENGE_FINALIZED' }));

      expect(pushSender.sendForNotification).toHaveBeenCalledTimes(2);
      const entityIds = pushSender.sendForNotification.mock.calls.map(
        ([row]: [{ entityId: string }]) => row.entityId,
      );
      expect(new Set(entityIds).size).toBe(2);
    });

    it('when sendForNotification rejects, that type becomes status error without stopping the rest of ALL', async () => {
      pushSender.sendForNotification.mockImplementation(async (row: { type: string }) => {
        if (row.type === 'INVITE_RECEIVED') {
          throw new Error('boom');
        }
      });

      const result = await service.run(dto({ userId: 'user-1', type: 'ALL' }));

      const inviteResult = result.results.find((r) => r.type === 'INVITE_RECEIVED')!;
      expect(inviteResult.status).toBe('error');
      expect(inviteResult.error).toBe('boom');

      const others = result.results.filter((r) => r.type !== 'INVITE_RECEIVED');
      expect(others.every((r) => r.status === 'sent')).toBe(true);
    });
  });

  it('always returns { dryRun, userId, evidenceDate, results } with evidenceDate from saoPauloDay()', async () => {
    const result = await service.run(dto({ userId: 'user-1', type: 'INVITE_RECEIVED', dryRun: true }));

    expect(result).toMatchObject({
      dryRun: true,
      userId: 'user-1',
      evidenceDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(Array.isArray(result.results)).toBe(true);
  });
});
