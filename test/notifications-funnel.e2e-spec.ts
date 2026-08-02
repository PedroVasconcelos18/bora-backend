import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotificationsService } from '../src/notifications/notifications.service';

// This e2e requires the local Postgres to be up and DATABASE_URL pointing at
// 127.0.0.1 — never `localhost`, which in this environment resolves via
// IPv6 to an empty Postgres and makes the test fail with a "table does not
// exist" error while the real database is healthy.
//
// Proves the riskiest hypothesis of D12-01 against the real Postgres
// (12-RESEARCH.md hypothesis A2): `createManyAndReturn` with
// `skipDuplicates: true` returns ONLY the rows that were actually inserted,
// never the whole input batch.
const TEST_USER = {
  email: `notif-funnel-${Date.now()}@bora.test`,
  passwordHash: 'not-a-real-hash-this-user-never-logs-in',
  name: 'Notification Funnel Tester',
};

describe('NotificationsService funnel (e2e, D12-01)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let notifications: NotificationsService;
  let eventEmitter: EventEmitter2;
  let userId: string;
  let spy: jest.Mock;
  let removeListener: () => void;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    notifications = moduleFixture.get<NotificationsService>(NotificationsService);
    eventEmitter = moduleFixture.get<EventEmitter2>(EventEmitter2);

    const user = await prisma.user.create({ data: TEST_USER });
    userId = user.id;
  });

  beforeEach(() => {
    spy = jest.fn();
    eventEmitter.on('notification.created', spy);
    removeListener = () => eventEmitter.off('notification.created', spy);
  });

  afterEach(() => {
    removeListener();
  });

  afterAll(async () => {
    // FK order matters: notifications before the user.
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await app.close();
  });

  it('createMany with 2 distinct entityIds for the same user emits exactly 2 events, each with a real persisted row (id present)', async () => {
    await notifications.createMany([
      { userId, type: 'CHALLENGE_ACTIVATED', entityId: 'challenge-e2e-1', payload: { a: 1 } },
      { userId, type: 'CHALLENGE_ACTIVATED', entityId: 'challenge-e2e-2', payload: { a: 2 } },
    ]);

    expect(spy).toHaveBeenCalledTimes(2);
    for (const call of spy.mock.calls) {
      const row = call[0];
      expect(row.id).toBeTruthy();
      expect(row.userId).toBe(userId);
    }
  });

  it('createMany re-run with 1 existing + 1 new entityId emits exactly 1 event, for the new row only (hypothesis A2)', async () => {
    // 'challenge-e2e-1' already exists from the previous test — skipDuplicates
    // must swallow it silently while still inserting 'challenge-e2e-3'.
    await notifications.createMany([
      { userId, type: 'CHALLENGE_ACTIVATED', entityId: 'challenge-e2e-1', payload: { a: 1 } },
      { userId, type: 'CHALLENGE_ACTIVATED', entityId: 'challenge-e2e-3', payload: { a: 3 } },
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    const row = spy.mock.calls[0][0];
    expect(row.entityId).toBe('challenge-e2e-3');
  });

  it('create for a new entityId emits 1 event; repeating the same call emits nothing more and does not throw (P2002 no-op)', async () => {
    await notifications.create({
      userId,
      type: 'CHALLENGE_FINALIZED',
      entityId: 'challenge-e2e-solo-1',
      payload: {},
    });
    expect(spy).toHaveBeenCalledTimes(1);

    await expect(
      notifications.create({
        userId,
        type: 'CHALLENGE_FINALIZED',
        entityId: 'challenge-e2e-solo-1',
        payload: {},
      }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
