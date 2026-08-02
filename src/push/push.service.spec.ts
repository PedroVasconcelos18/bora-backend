import { Test } from '@nestjs/testing';
import { PushService } from './push.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { Prisma } from '../generated/prisma/client.js';

describe('PushService (D12-07 per-type preference — T-11-07/08/09, T-12-09/10/11)', () => {
  let service: PushService;
  let prisma: {
    pushSubscription: {
      upsert: jest.Mock;
      deleteMany: jest.Mock;
      count: jest.Mock;
      findMany: jest.Mock;
      delete: jest.Mock;
    };
    notificationPreference: {
      findUnique: jest.Mock;
    };
  };

  const userId = 'user-1';
  const otherUserId = 'user-2';
  const endpoint = 'https://push.example.com/abc123';

  const dto: CreateSubscriptionDto = {
    endpoint,
    keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
  };

  beforeEach(async () => {
    prisma = {
      pushSubscription: {
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        delete: jest.fn().mockResolvedValue({}),
      },
      notificationPreference: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [PushService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(PushService);
  });

  describe('upsertSubscription', () => {
    it('creates one subscription row and never writes notification_preferences (Pitfall 1)', async () => {
      prisma.pushSubscription.findMany.mockResolvedValueOnce([{ endpoint }]);

      const result = await service.upsertSubscription(userId, dto);

      expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { endpoint },
          create: expect.objectContaining({ userId, endpoint, p256dh: 'p256dh-value', auth: 'auth-value' }),
        }),
      );
      expect((prisma.notificationPreference as unknown as Record<string, unknown>).upsert).toBeUndefined();
      expect(result).toEqual({ enabled: true, endpoints: [endpoint] });
    });

    it('re-points the same endpoint at the calling user on a second call (upsert, not create)', async () => {
      await service.upsertSubscription(otherUserId, dto);

      expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { endpoint },
          update: expect.objectContaining({ userId: otherUserId }),
        }),
      );
    });
  });

  describe('deleteSubscription', () => {
    it('removes only the row matching both endpoint AND userId', async () => {
      await service.deleteSubscription(userId, endpoint);

      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { endpoint, userId },
      });
    });

    it('deletes nothing for an endpoint belonging to another user (deleteMany matches zero rows)', async () => {
      prisma.pushSubscription.deleteMany.mockResolvedValueOnce({ count: 0 });

      await service.deleteSubscription(otherUserId, endpoint);

      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { endpoint, userId: otherUserId },
      });
    });

    it('never writes notification_preferences, even when it leaves the user with zero subscriptions (Pitfall 1)', async () => {
      prisma.pushSubscription.findMany.mockResolvedValueOnce([]);

      await service.deleteSubscription(userId, endpoint);

      expect((prisma.notificationPreference as unknown as Record<string, unknown>).upsert).toBeUndefined();
    });
  });

  describe('getStatus', () => {
    it('returns enabled=false and an empty endpoint list for a user who never subscribed', async () => {
      prisma.pushSubscription.findMany.mockResolvedValueOnce([]);

      const result = await service.getStatus(userId);

      expect(result).toEqual({ enabled: false, endpoints: [] });
    });

    it("returns enabled=true and the user's own endpoints only, scoped by userId, without reading preferences", async () => {
      prisma.pushSubscription.findMany.mockResolvedValueOnce([{ endpoint }, { endpoint: 'https://x/2' }]);

      const result = await service.getStatus(userId);

      expect(prisma.pushSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId } }),
      );
      expect(prisma.notificationPreference.findUnique).not.toHaveBeenCalled();
      expect(result).toEqual({ enabled: true, endpoints: [endpoint, 'https://x/2'] });
    });
  });

  describe('getPushTargets', () => {
    it('returns empty with zero subscriptions WITHOUT consulting notification_preferences at all (D12-07 porteiro)', async () => {
      prisma.pushSubscription.findMany.mockResolvedValueOnce([]);

      const result = await service.getPushTargets(userId, 'EVIDENCE_SUBMITTED');

      expect(result).toEqual({ enabled: false, subscriptions: [] });
      expect(prisma.notificationPreference.findUnique).not.toHaveBeenCalled();
    });

    it('falls back to the type default (enabled) when there is a subscription but no override row', async () => {
      const subs = [{ id: 'sub-1', endpoint, p256dh: 'p256dh-value', auth: 'auth-value' }];
      prisma.pushSubscription.findMany.mockResolvedValueOnce(subs);
      prisma.notificationPreference.findUnique.mockResolvedValueOnce(null);

      const result = await service.getPushTargets(userId, 'INVITE_RECEIVED');

      expect(result).toEqual({ enabled: true, subscriptions: subs });
    });

    it('falls back to the type default (disabled) for EVIDENCE_SUBMITTED when there is no override row', async () => {
      prisma.pushSubscription.findMany.mockResolvedValueOnce([
        { id: 'sub-1', endpoint, p256dh: 'p256dh-value', auth: 'auth-value' },
      ]);
      prisma.notificationPreference.findUnique.mockResolvedValueOnce(null);

      const result = await service.getPushTargets(userId, 'EVIDENCE_SUBMITTED');

      expect(result).toEqual({ enabled: false, subscriptions: [] });
    });

    it('returns empty when an override row disables the type, even though a subscription exists', async () => {
      prisma.pushSubscription.findMany.mockResolvedValueOnce([
        { id: 'sub-1', endpoint, p256dh: 'p256dh-value', auth: 'auth-value' },
      ]);
      prisma.notificationPreference.findUnique.mockResolvedValueOnce({ enabled: false });

      const result = await service.getPushTargets(userId, 'EVIDENCE_REMINDER');

      expect(result).toEqual({ enabled: false, subscriptions: [] });
    });

    it('returns subscriptions when an override row enables EVIDENCE_SUBMITTED (default-off type)', async () => {
      const subs = [{ id: 'sub-1', endpoint, p256dh: 'p256dh-value', auth: 'auth-value' }];
      prisma.pushSubscription.findMany.mockResolvedValueOnce(subs);
      prisma.notificationPreference.findUnique.mockResolvedValueOnce({ enabled: true });

      const result = await service.getPushTargets(userId, 'EVIDENCE_SUBMITTED');

      expect(result).toEqual({ enabled: true, subscriptions: subs });
    });

    it('queries the override by the composite userId_type key, scoped to the given user and type', async () => {
      prisma.pushSubscription.findMany.mockResolvedValueOnce([
        { id: 'sub-1', endpoint, p256dh: 'p256dh-value', auth: 'auth-value' },
      ]);
      prisma.notificationPreference.findUnique.mockResolvedValueOnce(null);

      await service.getPushTargets(userId, 'CHALLENGE_ACTIVATED');

      expect(prisma.notificationPreference.findUnique).toHaveBeenCalledWith({
        where: { userId_type: { userId, type: 'CHALLENGE_ACTIVATED' } },
      });
    });
  });

  describe('getReminderTargets (temporary bridge for PushSenderService, Plan 12-05 removes it)', () => {
    it('delegates to getPushTargets(userId, "EVIDENCE_REMINDER")', async () => {
      const spy = jest.spyOn(service, 'getPushTargets').mockResolvedValueOnce({ enabled: true, subscriptions: [] });

      const result = await service.getReminderTargets(userId);

      expect(spy).toHaveBeenCalledWith(userId, 'EVIDENCE_REMINDER');
      expect(result).toEqual({ enabled: true, subscriptions: [] });
    });
  });

  describe('pruneSubscription', () => {
    it('deletes the row by id', async () => {
      await service.pruneSubscription('sub-1');

      expect(prisma.pushSubscription.delete).toHaveBeenCalledWith({ where: { id: 'sub-1' } });
    });

    it('does not throw when the row is already gone (P2025 swallowed)', async () => {
      const p2025 = new Prisma.PrismaClientKnownRequestError('Record to delete does not exist.', {
        code: 'P2025',
        clientVersion: '7.8.0',
      });
      prisma.pushSubscription.delete.mockRejectedValueOnce(p2025);

      await expect(service.pruneSubscription('sub-1')).resolves.toBeUndefined();
    });

    it('re-throws a non-P2025 error', async () => {
      const otherError = new Error('connection lost');
      prisma.pushSubscription.delete.mockRejectedValueOnce(otherError);

      await expect(service.pruneSubscription('sub-1')).rejects.toThrow('connection lost');
    });
  });
});
