import { ConfigService } from '@nestjs/config';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { LocalStorageAdapter } from './local-storage.adapter';

describe('LocalStorageAdapter (V1 local ephemeral storage)', () => {
  let adapter: LocalStorageAdapter;
  let storageDir: string;

  const SECRET = 'test-storage-signing-secret';
  const BASE = 'http://localhost:3000';
  const KEY = 'evidences/challenge-1/participant-1/2026-07-09.jpg';

  const makeConfig = (overrides: Record<string, string | undefined> = {}): ConfigService => {
    const map: Record<string, string | undefined> = {
      STORAGE_SIGNING_SECRET: SECRET,
      PUBLIC_BASE_URL: BASE,
      LOCAL_STORAGE_DIR: storageDir,
      ...overrides,
    };
    return { get: (k: string) => map[k] } as unknown as ConfigService;
  };

  const parseSigned = (url: string) => {
    const u = new URL(url);
    return { exp: u.searchParams.get('exp')!, sig: u.searchParams.get('sig')! };
  };

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bora-storage-'));
    adapter = new LocalStorageAdapter(makeConfig());
  });

  afterEach(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('creates the storage dir at boot', () => {
    expect(fs.existsSync(storageDir)).toBe(true);
  });

  describe('getUploadUrl', () => {
    it('returns { uploadUrl, objectKey, expiresAt } with a signed, expiring URL pointing at the local /storage route', async () => {
      const result = await adapter.getUploadUrl({ key: KEY, contentType: 'image/jpeg' });

      expect(result.objectKey).toBe(KEY);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const u = new URL(result.uploadUrl);
      expect(`${u.origin}${decodeURIComponent(u.pathname)}`).toBe(`${BASE}/storage/${KEY}`);
      expect(u.searchParams.get('exp')).toBeTruthy();
      expect(u.searchParams.get('sig')).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('getPublicUrl', () => {
    it('returns the unsigned public read URL', () => {
      const url = adapter.getPublicUrl(KEY);
      const u = new URL(url);
      expect(`${u.origin}${decodeURIComponent(u.pathname)}`).toBe(`${BASE}/storage/${KEY}`);
      expect(u.searchParams.get('sig')).toBeNull();
    });
  });

  describe('verifyUploadSignature', () => {
    it('accepts the signature it just minted (happy path)', async () => {
      const { uploadUrl } = await adapter.getUploadUrl({ key: KEY, contentType: 'image/jpeg' });
      const { exp, sig } = parseSigned(uploadUrl);

      expect(adapter.isExpired(exp)).toBe(false);
      expect(adapter.verifyUploadSignature(KEY, exp, sig)).toBe(true);
    });

    it('rejects a tampered signature', async () => {
      const { uploadUrl } = await adapter.getUploadUrl({ key: KEY, contentType: 'image/jpeg' });
      const { exp, sig } = parseSigned(uploadUrl);
      const tampered = sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a');

      expect(adapter.verifyUploadSignature(KEY, exp, tampered)).toBe(false);
    });

    it('rejects a signature bound to a different key (Tampering)', async () => {
      const { uploadUrl } = await adapter.getUploadUrl({ key: KEY, contentType: 'image/jpeg' });
      const { exp, sig } = parseSigned(uploadUrl);

      expect(
        adapter.verifyUploadSignature('evidences/other/participant/2026-07-09.jpg', exp, sig),
      ).toBe(false);
    });

    it('rejects a malformed / wrong-length signature without throwing', async () => {
      const { uploadUrl } = await adapter.getUploadUrl({ key: KEY, contentType: 'image/jpeg' });
      const { exp } = parseSigned(uploadUrl);

      expect(adapter.verifyUploadSignature(KEY, exp, 'short')).toBe(false);
      expect(adapter.verifyUploadSignature(KEY, exp, '')).toBe(false);
    });

    it('treats a past expiry as expired', () => {
      const pastExp = Math.floor(Date.now() / 1000) - 10;
      expect(adapter.isExpired(pastExp)).toBe(true);
      expect(adapter.isExpired('not-a-number')).toBe(true);
    });
  });

  describe('resolvePath', () => {
    it('resolves a valid key to an absolute path inside the storage dir', () => {
      const target = adapter.resolvePath(KEY);
      expect(target.startsWith(path.resolve(storageDir) + path.sep)).toBe(true);
      expect(target.endsWith(path.join('evidences', 'challenge-1', 'participant-1', '2026-07-09.jpg'))).toBe(
        true,
      );
    });

    it('throws on a path-traversal key', () => {
      expect(() => adapter.resolvePath('../../etc/passwd')).toThrow();
      expect(() => adapter.resolvePath('evidences/../../../secret')).toThrow();
    });

    it('throws on a null-byte key', () => {
      expect(() => adapter.resolvePath('evidences/a\0b.jpg')).toThrow();
    });
  });

  describe('unconfigured signing secret', () => {
    it('falls back to a per-boot random secret (still self-consistent within the process)', async () => {
      const a2 = new LocalStorageAdapter(makeConfig({ STORAGE_SIGNING_SECRET: undefined }));
      const { uploadUrl } = await a2.getUploadUrl({ key: KEY, contentType: 'image/jpeg' });
      const { exp, sig } = parseSigned(uploadUrl);
      expect(a2.verifyUploadSignature(KEY, exp, sig)).toBe(true);
    });
  });
});
