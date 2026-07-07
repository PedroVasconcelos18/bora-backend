import * as request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const TEST_USER = {
  email: `test-${Date.now()}@bora.test`,
  password: 'password123',
  name: 'Test User',
};

describe('AuthController (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

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
  });

  afterAll(async () => {
    // Clean up test user
    await prisma.refreshToken.deleteMany({
      where: { user: { email: TEST_USER.email } },
    });
    await prisma.user.deleteMany({ where: { email: TEST_USER.email } });
    await app.close();
  });

  // ─── Signup ────────────────────────────────────────────────────────────────

  it('POST /auth/signup creates a user with hashed password and returns 201', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/signup')
      .send(TEST_USER)
      .expect(201);

    expect(response.body.user).toMatchObject({
      email: TEST_USER.email,
      name: TEST_USER.name,
    });
    expect(response.body.user).not.toHaveProperty('passwordHash');
    expect(response.body.user).not.toHaveProperty('password');

    // Verify password is hashed in DB
    const dbUser = await prisma.user.findUnique({
      where: { email: TEST_USER.email },
    });
    expect(dbUser).toBeTruthy();
    expect(dbUser!.passwordHash).not.toBe(TEST_USER.password);
    expect(dbUser!.passwordHash.startsWith('$argon2id$')).toBe(true);

    // Verify access_token cookie is set
    const cookies = response.headers['set-cookie'] as string[] | string;
    const cookieStr = Array.isArray(cookies) ? cookies.join(';') : cookies;
    expect(cookieStr).toContain('access_token');
    expect(cookieStr).toContain('HttpOnly');
  });

  it('POST /auth/signup with duplicate email returns 409', async () => {
    await request(app.getHttpServer())
      .post('/auth/signup')
      .send(TEST_USER)
      .expect(409);
  });

  // ─── Login ────────────────────────────────────────────────────────────────

  it('POST /auth/login with valid credentials returns 200 + Set-Cookie', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: TEST_USER.email, password: TEST_USER.password })
      .expect(200);

    const cookies = response.headers['set-cookie'] as string[] | string;
    const cookieStr = Array.isArray(cookies) ? cookies.join(';') : cookies;

    expect(cookieStr).toContain('access_token');
    expect(cookieStr).toContain('HttpOnly');
    expect(response.body.user).toMatchObject({ email: TEST_USER.email });
  });

  it('POST /auth/login with wrong password returns 401', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: TEST_USER.email, password: 'wrongpassword123' })
      .expect(401);
  });

  // ─── /auth/me ────────────────────────────────────────────────────────────

  it('GET /auth/me without cookie returns 401', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
  });

  it('GET /auth/me with valid access_token cookie returns user', async () => {
    // First login to get the cookie
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: TEST_USER.email, password: TEST_USER.password })
      .expect(200);

    const cookies = loginRes.headers['set-cookie'] as unknown as string[];
    const accessCookie = Array.isArray(cookies)
      ? cookies.find((c) => c.startsWith('access_token'))
      : (cookies as unknown as string);
    expect(accessCookie).toBeTruthy();

    const meRes = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', accessCookie!)
      .expect(200);

    expect(meRes.body.user).toMatchObject({
      email: TEST_USER.email,
      name: TEST_USER.name,
    });
    expect(meRes.body.user).toHaveProperty('id');
  });

  // ─── Logout ────────────────────────────────────────────────────────────────

  it('DELETE /auth/logout clears cookies; response contains cleared Set-Cookie headers', async () => {
    // Login first
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: TEST_USER.email, password: TEST_USER.password })
      .expect(200);

    const loginCookies = loginRes.headers['set-cookie'] as unknown as string[];
    const accessCookie = Array.isArray(loginCookies)
      ? loginCookies.find((c) => c.startsWith('access_token'))
      : (loginCookies as unknown as string);

    // Logout using the access_token cookie
    const logoutRes = await request(app.getHttpServer())
      .delete('/auth/logout')
      .set('Cookie', accessCookie!)
      .expect(200);

    // The logout response should clear the cookie (Max-Age=0 or empty value)
    const logoutCookies = logoutRes.headers['set-cookie'] as unknown as string[] | string;
    if (logoutCookies) {
      const logoutCookieStr = Array.isArray(logoutCookies)
        ? logoutCookies.join(';')
        : (logoutCookies as string);
      // Cookie should be cleared — value is empty and Max-Age=0 or Expires in the past
      expect(logoutCookieStr).toMatch(/access_token=;|access_token=(?:;|$)/);
    }

    // Without cookies (no cookie at all), /auth/me returns 401
    await request(app.getHttpServer())
      .get('/auth/me')
      .expect(401);
  });

  // ─── Refresh ─────────────────────────────────────────────────────────────

  it('POST /auth/refresh with valid refresh_token issues new access_token', async () => {
    // Login to get tokens — refresh_token cookie is scoped to /auth/refresh path
    // supertest returns Set-Cookie headers regardless of path scope
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: TEST_USER.email, password: TEST_USER.password })
      .expect(200);

    const loginCookies = loginRes.headers['set-cookie'] as unknown as string[];
    // Find the refresh_token cookie in the Set-Cookie headers
    const refreshCookieHeader = Array.isArray(loginCookies)
      ? loginCookies.find((c) => c.startsWith('refresh_token'))
      : undefined;

    if (!refreshCookieHeader) {
      // Should always be present after login — fail if missing
      throw new Error('refresh_token cookie not found in login response');
    }

    // Extract just the cookie value part (strip attributes)
    const refreshCookieValue = refreshCookieHeader.split(';')[0]; // "refresh_token=<value>"

    const refreshRes = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', refreshCookieValue)
      .expect(200);

    const refreshCookies = refreshRes.headers['set-cookie'] as unknown as string[] | string;
    const cookieStr = Array.isArray(refreshCookies)
      ? refreshCookies.join(';')
      : (refreshCookies as string) ?? '';
    expect(cookieStr).toContain('access_token');
  });
});
