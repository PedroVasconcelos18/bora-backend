import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { UserPayload } from '../auth/strategies/jwt.strategy';

describe('NotificationsController (V3 ownership/IDOR — T-09-01..04)', () => {
  let controller: NotificationsController;
  let prisma: {
    notification: {
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
    };
  };

  const userA: UserPayload = { id: 'user-A', email: 'a@bora.app', name: 'A' };
  const userB: UserPayload = { id: 'user-B', email: 'b@bora.app', name: 'B' };
  const notificationOfA = 'notif-belongs-to-A';

  beforeEach(async () => {
    prisma = {
      notification: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn(),
      },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [NotificationsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    controller = moduleRef.get(NotificationsController);
  });

  describe('PATCH /notifications/:id/read — cross-user IDOR (T-09-01)', () => {
    it('user B marking a notification that belongs to user A results in 404, never 200', async () => {
      // updateMany's WHERE (id: notificationOfA, userId: userB.id) matches zero
      // rows in the real DB — A's row has userId: userA.id, so it never
      // matches. Mock reflects that: 0 rows affected.
      prisma.notification.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(controller.markRead(notificationOfA, userB)).rejects.toThrow(
        NotFoundException,
      );

      // The barrier is the WHERE clause itself, not a pre-check — assert the
      // exact composite argument, proving userB.id (never userA's id or none)
      // is what gets sent to Prisma.
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: notificationOfA, userId: userB.id },
        data: { readAt: expect.any(Date) },
      });
    });

    it('the rightful owner (user A) marking their own notification succeeds', async () => {
      prisma.notification.updateMany.mockResolvedValueOnce({ count: 1 });

      await expect(controller.markRead(notificationOfA, userA)).resolves.toEqual({ ok: true });

      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: notificationOfA, userId: userA.id },
        data: { readAt: expect.any(Date) },
      });
    });
  });

  describe('POST /notifications/read-all — never accepts a foreign userId (T-09-04)', () => {
    it('scopes updateMany to the caller only', async () => {
      prisma.notification.updateMany.mockResolvedValueOnce({ count: 0 });

      await controller.markAllRead(userB);

      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: userB.id, readAt: null },
        data: { readAt: expect.any(Date) },
      });
    });
  });

  describe('GET /notifications and /notifications/unread-count — always scoped to @CurrentUser() (T-09-02)', () => {
    it('list() passes currentUser.id to findMany, never a query/param value', async () => {
      await controller.list(undefined, userA);

      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: userA.id } }),
      );
    });

    it('unreadCount() passes currentUser.id to count, never a query/param value', async () => {
      await controller.unreadCount(userB);

      expect(prisma.notification.count).toHaveBeenCalledWith({
        where: { userId: userB.id, readAt: null },
      });
    });
  });
});
