import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client.js';

describe('NotificationsService (NOTIF-01/03, T-09-01)', () => {
  let service: NotificationsService;
  let prisma: {
    notification: {
      create: jest.Mock;
      createMany: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
    };
  };

  const userId = 'user-1';
  const otherUserId = 'user-2';
  const notificationId = 'notif-1';

  beforeEach(async () => {
    prisma = {
      notification: {
        create: jest.fn(),
        createMany: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        updateMany: jest.fn(),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [NotificationsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(NotificationsService);
  });

  describe('create', () => {
    it('swallows a P2002 (duplicate dedupe key) as a legitimate no-op', async () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`user_id`,`type`,`entity_id`)',
        { code: 'P2002', clientVersion: '7.8.0' },
      );
      prisma.notification.create.mockRejectedValueOnce(p2002);

      await expect(
        service.create({ userId, type: 'INVITE_RECEIVED', entityId: 'invite-1', payload: {} }),
      ).resolves.toBeUndefined();
    });

    it('re-throws a non-P2002 error', async () => {
      const otherError = new Error('connection lost');
      prisma.notification.create.mockRejectedValueOnce(otherError);

      await expect(
        service.create({ userId, type: 'INVITE_RECEIVED', entityId: 'invite-1', payload: {} }),
      ).rejects.toThrow('connection lost');
    });
  });

  describe('createMany', () => {
    it('is a no-op with an empty array — never calls prisma', async () => {
      await service.createMany([]);
      expect(prisma.notification.createMany).not.toHaveBeenCalled();
    });
  });

  describe('markRead', () => {
    it('throws NotFoundException when updateMany affects zero rows (cross-user or nonexistent id)', async () => {
      prisma.notification.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.markRead(otherUserId, notificationId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('scopes the WHERE clause to exactly { id, userId } — never id alone (T-09-01)', async () => {
      prisma.notification.updateMany.mockResolvedValueOnce({ count: 1 });

      await service.markRead(userId, notificationId);

      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: notificationId, userId },
        data: { readAt: expect.any(Date) },
      });
    });
  });

  describe('markAllRead', () => {
    it('never throws when zero rows are unread — a no-op is legitimate', async () => {
      prisma.notification.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.markAllRead(userId)).resolves.toBeUndefined();
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId, readAt: null },
        data: { readAt: expect.any(Date) },
      });
    });
  });
});
