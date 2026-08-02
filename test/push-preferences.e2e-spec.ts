import * as request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// This e2e requires the local Postgres to be up and DATABASE_URL pointing at
// 127.0.0.1 — never `localhost`, which in this environment resolves via
// IPv6 to an empty Postgres and makes the test fail with a "table does not
// exist" error while the real database is healthy.
//
// Proves the ligar/desligar/voltar-ao-default cycle (D12-04/D12-07) against
// the real Postgres and real JWT auth, not mocks: reading resolves all 9
// types from PUSH_CONFIG_BY_TYPE, writing a non-default value materializes
// exactly one override row, and writing the default value back deletes it —
// "absence of a row = default" stays true.
const TEST_USER = {
  email: `push-prefs-${Date.now()}@bora.test`,
  password: 'password123',
  name: 'Push Preferences Tester',
};

describe('PushPreferencesController (e2e, D12-04/D12-07)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userId: string;
  let accessCookie: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);

    const signupRes = await request(app.getHttpServer())
      .post('/auth/signup')
      .send(TEST_USER)
      .expect(201);

    userId = signupRes.body.user.id;

    const cookies = signupRes.headers['set-cookie'] as unknown as string[];
    const found = Array.isArray(cookies)
      ? cookies.find((c) => c.startsWith('access_token'))
      : (cookies as unknown as string);
    if (!found) {
      throw new Error('access_token cookie not found in signup response');
    }
    accessCookie = found;
  });

  afterAll(async () => {
    // FK order: notification_preferences → refresh_tokens → user.
    await prisma.notificationPreference.deleteMany({ where: { userId } });
    await prisma.refreshToken.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await app.close();
  });

  it('GET /push/preferences with no overrides returns 200 with all 9 defaults, EVIDENCE_SUBMITTED off', async () => {
    const res = await request(app.getHttpServer())
      .get('/push/preferences')
      .set('Cookie', accessCookie)
      .expect(200);

    expect(res.body).toHaveLength(9);
    const byType = new Map(
      (res.body as Array<{ type: string; enabled: boolean }>).map((r) => [r.type, r.enabled]),
    );
    expect(byType.get('EVIDENCE_SUBMITTED')).toBe(false);
    for (const [type, enabled] of byType) {
      if (type !== 'EVIDENCE_SUBMITTED') {
        expect(enabled).toBe(true);
      }
    }
  });

  it('POST /push/preferences disabling EVIDENCE_REMINDER materializes exactly 1 override row', async () => {
    const res = await request(app.getHttpServer())
      .post('/push/preferences')
      .set('Cookie', accessCookie)
      .send({ type: 'EVIDENCE_REMINDER', enabled: false })
      .expect(200);

    const byType = new Map(
      (res.body as Array<{ type: string; enabled: boolean }>).map((r) => [r.type, r.enabled]),
    );
    expect(byType.get('EVIDENCE_REMINDER')).toBe(false);

    const rows = await prisma.notificationPreference.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'EVIDENCE_REMINDER', enabled: false });
  });

  it('POST /push/preferences back to the default (true) deletes the override — row count returns to 0', async () => {
    const res = await request(app.getHttpServer())
      .post('/push/preferences')
      .set('Cookie', accessCookie)
      .send({ type: 'EVIDENCE_REMINDER', enabled: true })
      .expect(200);

    const byType = new Map(
      (res.body as Array<{ type: string; enabled: boolean }>).map((r) => [r.type, r.enabled]),
    );
    expect(byType.get('EVIDENCE_REMINDER')).toBe(true);

    const rows = await prisma.notificationPreference.findMany({ where: { userId } });
    expect(rows).toHaveLength(0);
  });

  it('POST /push/preferences enabling EVIDENCE_SUBMITTED (default-off) creates 1 row, GET reflects it enabled', async () => {
    await request(app.getHttpServer())
      .post('/push/preferences')
      .set('Cookie', accessCookie)
      .send({ type: 'EVIDENCE_SUBMITTED', enabled: true })
      .expect(200);

    const rows = await prisma.notificationPreference.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'EVIDENCE_SUBMITTED', enabled: true });

    const getRes = await request(app.getHttpServer())
      .get('/push/preferences')
      .set('Cookie', accessCookie)
      .expect(200);
    const byType = new Map(
      (getRes.body as Array<{ type: string; enabled: boolean }>).map((r) => [r.type, r.enabled]),
    );
    expect(byType.get('EVIDENCE_SUBMITTED')).toBe(true);

    // Clean up this row before the next test's row-count assertions.
    await prisma.notificationPreference.deleteMany({ where: { userId, type: 'EVIDENCE_SUBMITTED' } });
  });

  it('POST /push/preferences with an unknown type returns 400 and creates no row', async () => {
    await request(app.getHttpServer())
      .post('/push/preferences')
      .set('Cookie', accessCookie)
      .send({ type: 'NOT_A_REAL_TYPE', enabled: true })
      .expect(400);

    const rows = await prisma.notificationPreference.findMany({ where: { userId } });
    expect(rows).toHaveLength(0);
  });

  it('GET /push/preferences without a session cookie returns 401', async () => {
    await request(app.getHttpServer()).get('/push/preferences').expect(401);
  });
});
