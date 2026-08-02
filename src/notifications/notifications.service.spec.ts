import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client.js';

describe('NotificationsService (NOTIF-01/03, T-09-01, D12-01)', () => {
  let service: NotificationsService;
  let prisma: {
    notification: {
      create: jest.Mock;
      createMany: jest.Mock;
      createManyAndReturn: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let eventEmitter: { emit: jest.Mock };

  const userId = 'user-1';
  const otherUserId = 'user-2';
  const notificationId = 'notif-1';

  beforeEach(async () => {
    prisma = {
      notification: {
        create: jest.fn(),
        createMany: jest.fn(),
        createManyAndReturn: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    eventEmitter = { emit: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = moduleRef.get(NotificationsService);
  });

  describe('create', () => {
    it('emits notification.created exactly once, with the row returned by Prisma, on success', async () => {
      const createdRow = { id: 'notif-1', userId, type: 'INVITE_RECEIVED', entityId: 'invite-1' };
      prisma.notification.create.mockResolvedValueOnce(createdRow);

      await service.create({ userId, type: 'INVITE_RECEIVED', entityId: 'invite-1', payload: {} });

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith('notification.created', createdRow);
    });

    it('swallows a P2002 (duplicate dedupe key) as a legitimate no-op and emits nothing', async () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`user_id`,`type`,`entity_id`)',
        { code: 'P2002', clientVersion: '7.8.0' },
      );
      prisma.notification.create.mockRejectedValueOnce(p2002);

      await expect(
        service.create({ userId, type: 'INVITE_RECEIVED', entityId: 'invite-1', payload: {} }),
      ).resolves.toBeUndefined();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('re-throws a non-P2002 error and emits nothing', async () => {
      const otherError = new Error('connection lost');
      prisma.notification.create.mockRejectedValueOnce(otherError);

      await expect(
        service.create({ userId, type: 'INVITE_RECEIVED', entityId: 'invite-1', payload: {} }),
      ).rejects.toThrow('connection lost');
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('createMany', () => {
    it('is a no-op with an empty array — never calls prisma nor emits', async () => {
      await service.createMany([]);
      expect(prisma.notification.createManyAndReturn).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('uses createManyAndReturn with skipDuplicates, and emits once per row actually returned', async () => {
      const returnedRows = [
        { id: 'notif-1', userId, type: 'PAYMENT_CONFIRMED', entityId: 'payment-1' },
        { id: 'notif-2', userId: otherUserId, type: 'PAYMENT_CONFIRMED', entityId: 'payment-1' },
      ];
      prisma.notification.createManyAndReturn.mockResolvedValueOnce(returnedRows);

      await service.createMany([
        { userId, type: 'PAYMENT_CONFIRMED', entityId: 'payment-1', payload: {} },
        { userId: otherUserId, type: 'PAYMENT_CONFIRMED', entityId: 'payment-1', payload: {} },
        { userId: otherUserId, type: 'PAYMENT_CONFIRMED', entityId: 'payment-1', payload: {} },
      ]);

      expect(prisma.notification.createManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledTimes(2);
      expect(eventEmitter.emit).toHaveBeenNthCalledWith(1, 'notification.created', returnedRows[0]);
      expect(eventEmitter.emit).toHaveBeenNthCalledWith(2, 'notification.created', returnedRows[1]);
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
