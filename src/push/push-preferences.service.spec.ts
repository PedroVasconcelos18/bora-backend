import { Test } from '@nestjs/testing';
import { PushPreferencesService } from './push-preferences.service';
import { PrismaService } from '../prisma/prisma.service';
import { PUSH_CONFIG_BY_TYPE } from './config/push-copy.config';

describe('PushPreferencesService (D12-07 — read resolves, write only materializes deviations)', () => {
  let service: PushPreferencesService;
  let prisma: {
    notificationPreference: {
      findMany: jest.Mock;
      deleteMany: jest.Mock;
      upsert: jest.Mock;
    };
  };

  const userId = 'user-1';

  beforeEach(async () => {
    prisma = {
      notificationPreference: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [PushPreferencesService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(PushPreferencesService);
  });

  describe('listPreferences', () => {
    it('with no override rows, returns all 9 types resolved to their PUSH_CONFIG_BY_TYPE default, including EVIDENCE_SUBMITTED off', async () => {
      const result = await service.listPreferences(userId);

      expect(result).toHaveLength(9);
      const byType = new Map(result.map((r) => [r.type, r.enabled]));
      for (const [type, config] of Object.entries(PUSH_CONFIG_BY_TYPE)) {
        expect(byType.get(type as never)).toBe(config.defaultEnabled);
      }
      expect(byType.get('EVIDENCE_SUBMITTED' as never)).toBe(false);
      expect(prisma.notificationPreference.findMany).toHaveBeenCalledWith({ where: { userId } });
    });

    it('with an override disabling a default-on type, only that entry changes', async () => {
      prisma.notificationPreference.findMany.mockResolvedValueOnce([
        { userId, type: 'INVITE_RECEIVED', enabled: false },
      ]);

      const result = await service.listPreferences(userId);
      const byType = new Map(result.map((r) => [r.type, r.enabled]));

      expect(byType.get('INVITE_RECEIVED' as never)).toBe(false);
      expect(byType.get('PAYMENT_CONFIRMED' as never)).toBe(true);
      expect(result).toHaveLength(9);
    });

    it('with an override enabling EVIDENCE_SUBMITTED (default-off type), only that entry changes', async () => {
      prisma.notificationPreference.findMany.mockResolvedValueOnce([
        { userId, type: 'EVIDENCE_SUBMITTED', enabled: true },
      ]);

      const result = await service.listPreferences(userId);
      const byType = new Map(result.map((r) => [r.type, r.enabled]));

      expect(byType.get('EVIDENCE_SUBMITTED' as never)).toBe(true);
      expect(byType.get('EVIDENCE_VALIDATED' as never)).toBe(true);
      expect(result).toHaveLength(9);
    });
  });

  describe('setPreference', () => {
    it('with a value different from the default, upserts by the composite key and never calls deleteMany', async () => {
      // EVIDENCE_SUBMITTED defaults to false — enabling it deviates.
      await service.setPreference(userId, 'EVIDENCE_SUBMITTED', true);

      expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith({
        where: { userId_type: { userId, type: 'EVIDENCE_SUBMITTED' } },
        create: { userId, type: 'EVIDENCE_SUBMITTED', enabled: true },
        update: { enabled: true },
      });
      expect(prisma.notificationPreference.deleteMany).not.toHaveBeenCalled();
    });

    it('with a value equal to the default (default-on type), deletes any override and never calls upsert', async () => {
      await service.setPreference(userId, 'INVITE_RECEIVED', true);

      expect(prisma.notificationPreference.deleteMany).toHaveBeenCalledWith({
        where: { userId, type: 'INVITE_RECEIVED' },
      });
      expect(prisma.notificationPreference.upsert).not.toHaveBeenCalled();
    });

    it('with a value equal to the default (EVIDENCE_SUBMITTED, default-off type), deletes any override and never calls upsert', async () => {
      await service.setPreference(userId, 'EVIDENCE_SUBMITTED', false);

      expect(prisma.notificationPreference.deleteMany).toHaveBeenCalledWith({
        where: { userId, type: 'EVIDENCE_SUBMITTED' },
      });
      expect(prisma.notificationPreference.upsert).not.toHaveBeenCalled();
    });
  });
});
