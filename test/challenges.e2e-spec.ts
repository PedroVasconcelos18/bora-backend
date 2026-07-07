import * as request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const TEST_USER = {
  email: `challenge-test-${Date.now()}@bora.test`,
  password: 'password123',
  name: 'Challenge Tester',
};

const VALID_CHALLENGE = {
  title: 'Quem vai mais à academia',
  emoji: '🏋️',
  durationDays: 14,
  collabAmount: 50,
  invitees: ['friend1@bora.test', 'friend2@bora.test'],
};

describe('ChallengesController (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessCookie: string;
  let createdChallengeId: string;

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

    // Sign up and capture access_token cookie for authenticated requests
    const signupRes = await request(app.getHttpServer())
      .post('/auth/signup')
      .send(TEST_USER)
      .expect(201);

    const cookies = signupRes.headers['set-cookie'] as unknown as string[];
    accessCookie = Array.isArray(cookies)
      ? cookies.find((c) => c.startsWith('access_token')) ?? ''
      : String(cookies);
    expect(accessCookie).toBeTruthy();
  });

  afterAll(async () => {
    // Clean up in correct order (foreign key constraints)
    const user = await prisma.user.findUnique({ where: { email: TEST_USER.email } });
    if (user) {
      // Find challenges by this user
      const challenges = await prisma.challenge.findMany({ where: { creatorId: user.id } });
      for (const c of challenges) {
        await prisma.invite.deleteMany({ where: { challengeId: c.id } });
        await prisma.participant.deleteMany({ where: { challengeId: c.id } });
      }
      await prisma.challenge.deleteMany({ where: { creatorId: user.id } });
      await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
    await app.close();
  });

  // ─── POST /challenges ────────────────────────────────────────────────────────

  it('POST /challenges without auth returns 401', async () => {
    await request(app.getHttpServer())
      .post('/challenges')
      .send(VALID_CHALLENGE)
      .expect(401);
  });

  it('POST /challenges with valid body persists Challenge with status WAITING', async () => {
    const res = await request(app.getHttpServer())
      .post('/challenges')
      .set('Cookie', accessCookie)
      .send(VALID_CHALLENGE)
      .expect(201);

    expect(res.body.id).toBeTruthy();
    expect(res.body.title).toBe(VALID_CHALLENGE.title);
    expect(res.body.emoji).toBe(VALID_CHALLENGE.emoji);
    expect(res.body.status).toBe('WAITING');
    createdChallengeId = res.body.id as string;
  });

  it('POST /challenges — creator recorded as Participant with status INVITED and paidAt null (D-11)', async () => {
    // Re-create to ensure we have a fresh one (or reuse createdChallengeId)
    const participant = await prisma.participant.findFirst({
      where: { challengeId: createdChallengeId },
      include: { user: true },
    });

    expect(participant).toBeTruthy();
    expect(participant!.status).toBe('INVITED');
    expect(participant!.paidAt).toBeNull();
    expect(participant!.user.email).toBe(TEST_USER.email);
  });

  it('POST /challenges — one Invite per invitee email with unique token + correct targetEmail + challengeId', async () => {
    const invites = await prisma.invite.findMany({
      where: { challengeId: createdChallengeId },
    });

    expect(invites).toHaveLength(VALID_CHALLENGE.invitees.length);

    const targetEmails = invites.map((i) => i.targetEmail);
    for (const email of VALID_CHALLENGE.invitees) {
      expect(targetEmails).toContain(email.toLowerCase());
    }

    // All tokens are unique
    const tokens = invites.map((i) => i.token);
    const uniqueTokens = new Set(tokens);
    expect(uniqueTokens.size).toBe(tokens.length);

    // All challengeIds correct
    for (const invite of invites) {
      expect(invite.challengeId).toBe(createdChallengeId);
    }
  });

  it('POST /challenges — response includes copyableLink for each invitee', async () => {
    const res = await request(app.getHttpServer())
      .post('/challenges')
      .set('Cookie', accessCookie)
      .send({ ...VALID_CHALLENGE, title: 'Second challenge' })
      .expect(201);

    expect(res.body.copyableLinks).toBeTruthy();
    expect(Array.isArray(res.body.copyableLinks)).toBe(true);
    expect(res.body.copyableLinks).toHaveLength(VALID_CHALLENGE.invitees.length);
    for (const link of res.body.copyableLinks as { copyableLink: string }[]) {
      expect(link.copyableLink).toMatch(/\/invites\//);
    }
  });

  // ─── Validation: 400 rejections ──────────────────────────────────────────────

  it('POST /challenges with durationDays < 3 returns 400', async () => {
    await request(app.getHttpServer())
      .post('/challenges')
      .set('Cookie', accessCookie)
      .send({ ...VALID_CHALLENGE, durationDays: 2 })
      .expect(400);
  });

  it('POST /challenges with collabAmount < 5 returns 400', async () => {
    await request(app.getHttpServer())
      .post('/challenges')
      .set('Cookie', accessCookie)
      .send({ ...VALID_CHALLENGE, collabAmount: 4 })
      .expect(400);
  });

  it('POST /challenges with fewer than 2 invitees returns 400', async () => {
    await request(app.getHttpServer())
      .post('/challenges')
      .set('Cookie', accessCookie)
      .send({ ...VALID_CHALLENGE, invitees: ['onlyone@bora.test'] })
      .expect(400);
  });

  it('POST /challenges with invalid email in invitees returns 400', async () => {
    await request(app.getHttpServer())
      .post('/challenges')
      .set('Cookie', accessCookie)
      .send({ ...VALID_CHALLENGE, invitees: ['not-an-email', 'also-not@valid'] })
      .expect(400);
  });

  // ─── GET /challenges ─────────────────────────────────────────────────────────

  it('GET /challenges without auth returns 401', async () => {
    await request(app.getHttpServer()).get('/challenges').expect(401);
  });

  it("GET /challenges (authed) lists the caller's challenges", async () => {
    const res = await request(app.getHttpServer())
      .get('/challenges')
      .set('Cookie', accessCookie)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    // All returned challenges belong to the authenticated user
    for (const c of res.body as { status: string }[]) {
      expect(c.status).toBeTruthy();
    }
  });

  // ─── GET /challenges/:id ──────────────────────────────────────────────────────

  it('GET /challenges/:id returns the challenge with participants and status', async () => {
    const res = await request(app.getHttpServer())
      .get(`/challenges/${createdChallengeId}`)
      .set('Cookie', accessCookie)
      .expect(200);

    expect(res.body.id).toBe(createdChallengeId);
    expect(res.body.status).toBe('WAITING');
    expect(Array.isArray(res.body.participants)).toBe(true);
  });

  it('GET /challenges/:id for non-existent id returns 404', async () => {
    await request(app.getHttpServer())
      .get('/challenges/non-existent-id-00000000')
      .set('Cookie', accessCookie)
      .expect(404);
  });
});
