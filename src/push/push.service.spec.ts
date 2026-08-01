import { Test } from '@nestjs/testing';
import { PushService } from './push.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { Prisma } from '../generated/prisma/client.js';

describe('PushService (D-08 persistence — T-11-07/08/09)', () => {
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
      upsert: jest.Mock;
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
        upsert: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [PushService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(PushService);
  });

  describe('upsertSubscription', () => {
    it('creates one subscription row and enables the preference for a brand-new endpoint', async () => {
      prisma.notificationPreference.findUnique.mockResolvedValueOnce({ pushRemindersEnabled: true });
      prisma.pushSubscription.findMany.mockResolvedValueOnce([{ endpoint }]);

      const result = await service.upsertSubscription(userId, dto);

      expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { endpoint },
          create: expect.objectContaining({ userId, endpoint, p256dh: 'p256dh-value', auth: 'auth-value' }),
        }),
      );
      expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId },
          create: expect.objectContaining({ userId, pushRemindersEnabled: true }),
          update: expect.objectContaining({ pushRemindersEnabled: true }),
        }),
      );
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
      prisma.pushSubscription.count.mockResolvedValueOnce(3);

      await service.deleteSubscription(otherUserId, endpoint);

      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { endpoint, userId: otherUserId },
      });
      expect(prisma.notificationPreference.upsert).not.toHaveBeenCalled();
    });

    it('disables the preference when it leaves the user with zero rows', async () => {
      prisma.pushSubscription.count.mockResolvedValueOnce(0);

      await service.deleteSubscription(userId, endpoint);

      expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId },
          update: expect.objectContaining({ pushRemindersEnabled: false }),
        }),
      );
    });

    it('keeps the preference enabled when the user still has other rows', async () => {
      prisma.pushSubscription.count.mockResolvedValueOnce(2);

      await service.deleteSubscription(userId, endpoint);

      expect(prisma.notificationPreference.upsert).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('returns enabled=false and an empty endpoint list for a user who never subscribed', async () => {
      prisma.notificationPreference.findUnique.mockResolvedValueOnce(null);
      prisma.pushSubscription.findMany.mockResolvedValueOnce([]);

      const result = await service.getStatus(userId);

      expect(result).toEqual({ enabled: false, endpoints: [] });
    });

    it("returns the user's own endpoints only, scoped by userId", async () => {
      prisma.notificationPreference.findUnique.mockResolvedValueOnce({ pushRemindersEnabled: true });
      prisma.pushSubscription.findMany.mockResolvedValueOnce([{ endpoint }, { endpoint: 'https://x/2' }]);

      const result = await service.getStatus(userId);

      expect(prisma.pushSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId } }),
      );
      expect(result).toEqual({ enabled: true, endpoints: [endpoint, 'https://x/2'] });
    });
  });

  describe('getReminderTargets', () => {
    it('returns an empty subscription list when the preference is disabled, even if rows exist', async () => {
      prisma.notificationPreference.findUnique.mockResolvedValueOnce({ pushRemindersEnabled: false });

      const result = await service.getReminderTargets(userId);

      expect(result).toEqual({ enabled: false, subscriptions: [] });
      expect(prisma.pushSubscription.findMany).not.toHaveBeenCalled();
    });

    it('returns the subscriptions with delivery keys when the preference is enabled', async () => {
      prisma.notificationPreference.findUnique.mockResolvedValueOnce({ pushRemindersEnabled: true });
      prisma.pushSubscription.findMany.mockResolvedValueOnce([
        { id: 'sub-1', endpoint, p256dh: 'p256dh-value', auth: 'auth-value' },
      ]);

      const result = await service.getReminderTargets(userId);

      expect(result).toEqual({
        enabled: true,
        subscriptions: [{ id: 'sub-1', endpoint, p256dh: 'p256dh-value', auth: 'auth-value' }],
      });
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
