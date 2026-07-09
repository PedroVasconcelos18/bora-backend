import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminGuard } from './admin.guard';

/**
 * D-11: the /admin refund queue is gated by a shared env secret, not the
 * user JWT. AdminGuard reads X-Admin-Secret and compares it against
 * ConfigService's ADMIN_SECRET via crypto.timingSafeEqual (T-02-22 — never
 * `===`, a timing side-channel on secret-derived values). It must fail
 * closed: a missing header, a wrong secret, or an unconfigured ADMIN_SECRET
 * all reject the request (T-02-20).
 */
describe('AdminGuard', () => {
  const FIXTURE_SECRET = 'test-admin-secret-fixture-do-not-use-in-prod';

  function makeContext(headerValue?: string): ExecutionContext {
    const request = {
      headers: headerValue === undefined ? {} : { 'x-admin-secret': headerValue },
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  }

  function makeGuard(configuredSecret: string | undefined): AdminGuard {
    const config = { get: jest.fn().mockReturnValue(configuredSecret) } as unknown as ConfigService;
    return new AdminGuard(config);
  }

  it('passes a request whose X-Admin-Secret header exactly matches ADMIN_SECRET', () => {
    const guard = makeGuard(FIXTURE_SECRET);

    expect(guard.canActivate(makeContext(FIXTURE_SECRET))).toBe(true);
  });

  it('rejects a request with a missing X-Admin-Secret header', () => {
    const guard = makeGuard(FIXTURE_SECRET);

    expect(guard.canActivate(makeContext(undefined))).toBe(false);
  });

  it('rejects a request with a wrong X-Admin-Secret header', () => {
    const guard = makeGuard(FIXTURE_SECRET);

    expect(guard.canActivate(makeContext('wrong-secret'))).toBe(false);
  });

  it('rejects a request with an empty-string X-Admin-Secret header', () => {
    const guard = makeGuard(FIXTURE_SECRET);

    expect(guard.canActivate(makeContext(''))).toBe(false);
  });

  it('fails closed when ADMIN_SECRET is not configured (undefined), even with a header present', () => {
    const guard = makeGuard(undefined);

    expect(guard.canActivate(makeContext('anything'))).toBe(false);
  });

  it('fails closed when ADMIN_SECRET is configured as an empty string', () => {
    const guard = makeGuard('');

    expect(guard.canActivate(makeContext(''))).toBe(false);
  });
});
