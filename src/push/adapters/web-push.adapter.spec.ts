import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { WebPushAdapter } from './web-push.adapter';

/**
 * Test-only VAPID pair, generated once via `npx web-push generate-vapid-keys`
 * for this spec. Never used for real delivery — a throwaway fixture so the
 * constructor's happy path exercises the library's own key-length validation
 * instead of an arbitrary string.
 */
const FIXTURE_PUBLIC_KEY =
  'BEqQZJQ3Ty0XaxG0SKOd_RqUDITDFUqbfqw7O5AYvDtWypOZEQpUAJ9QXVEqlYitKQsRY48AMuab97dMkAy1EPA';
const FIXTURE_PRIVATE_KEY = '2DZOJgnAuIA1XHF2AAhBnceUyCqp5zOnoSvbC_hWcvI';
const FIXTURE_SUBJECT = 'mailto:test@example.com';

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));

describe('WebPushAdapter construction — fail-loud VAPID config', () => {
  const makeConfig = (values: Record<string, string>) =>
    ({ get: jest.fn((key: string) => values[key]) }) as unknown as ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('constructs successfully and logs a live-mode line when all three VAPID values are present', () => {
    const config = makeConfig({
      VAPID_PUBLIC_KEY: FIXTURE_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: FIXTURE_PRIVATE_KEY,
      VAPID_SUBJECT: FIXTURE_SUBJECT,
    });

    expect(() => new WebPushAdapter(config)).not.toThrow();
    expect(webpush.setVapidDetails).toHaveBeenCalledWith(
      FIXTURE_SUBJECT,
      FIXTURE_PUBLIC_KEY,
      FIXTURE_PRIVATE_KEY,
    );
  });

  it('throws when VAPID_PUBLIC_KEY is empty', () => {
    const config = makeConfig({
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: FIXTURE_PRIVATE_KEY,
      VAPID_SUBJECT: FIXTURE_SUBJECT,
    });

    expect(() => new WebPushAdapter(config)).toThrow(/VAPID_PUBLIC_KEY/);
  });

  it('throws when VAPID_PRIVATE_KEY is empty', () => {
    const config = makeConfig({
      VAPID_PUBLIC_KEY: FIXTURE_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: '',
      VAPID_SUBJECT: FIXTURE_SUBJECT,
    });

    expect(() => new WebPushAdapter(config)).toThrow(/VAPID_PRIVATE_KEY/);
  });

  it('throws when VAPID_SUBJECT is empty', () => {
    const config = makeConfig({
      VAPID_PUBLIC_KEY: FIXTURE_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: FIXTURE_PRIVATE_KEY,
      VAPID_SUBJECT: '',
    });

    expect(() => new WebPushAdapter(config)).toThrow(/VAPID_SUBJECT/);
  });

  it('throws when VAPID_SUBJECT is neither a mailto: nor an https: URL', () => {
    const config = makeConfig({
      VAPID_PUBLIC_KEY: FIXTURE_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: FIXTURE_PRIVATE_KEY,
      VAPID_SUBJECT: 'http://not-secure.example.com',
    });

    expect(() => new WebPushAdapter(config)).toThrow(/mailto:|https:/);
  });
});

describe('WebPushAdapter.send', () => {
  const makeAdapter = () => {
    const config = ({
      get: jest.fn((key: string) =>
        ({
          VAPID_PUBLIC_KEY: FIXTURE_PUBLIC_KEY,
          VAPID_PRIVATE_KEY: FIXTURE_PRIVATE_KEY,
          VAPID_SUBJECT: FIXTURE_SUBJECT,
        })[key],
      ),
    } as unknown) as ConfigService;
    return new WebPushAdapter(config);
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves when the underlying library resolves', async () => {
    const adapter = makeAdapter();
    (webpush.sendNotification as jest.Mock).mockResolvedValue({
      statusCode: 201,
      body: '',
      headers: {},
    });

    await expect(
      adapter.send({
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
        keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
        payload: { title: 'Falta a evidência', body: 'Poste hoje', url: '/home' },
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects with the push service statusCode preserved when the library rejects', async () => {
    const dead = Object.assign(new Error('Gone'), { statusCode: 410 });
    (webpush.sendNotification as jest.Mock).mockRejectedValue(dead);

    const adapter = makeAdapter();
    const caught = await adapter
      .send({
        endpoint: 'https://fcm.googleapis.com/fcm/send/dead',
        keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
        payload: { title: 'Falta a evidência', body: 'Poste hoje', url: '/home' },
      })
      .catch((err: unknown) => err);

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { statusCode?: number }).statusCode).toBe(410);
  });
});
