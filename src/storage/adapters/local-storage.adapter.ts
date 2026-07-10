import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  GetUploadUrlParams,
  IObjectStorage,
  UploadUrlResult,
} from '../interfaces/object-storage.interface';
import { PRESIGN_TTL_SECONDS, resolveStorageDir } from '../storage.constants';

/**
 * LocalStorageAdapter — the V1 ephemeral storage backend (design pivot,
 * 2026-07-09): evidence photos only need to survive the 24h vote window, so
 * they live on the backend's local filesystem and are swept by an hourly
 * cleanup cron (EvidenceCleanupJob) rather than being uploaded to Cloudflare
 * R2. Implemented behind the same IObjectStorage interface as R2Adapter, so
 * swapping back to presigned-direct-to-R2 later is an adapter change only
 * (select via STORAGE_DRIVER; default 'local').
 *
 * The two-step frontend contract is preserved byte-for-byte: getUploadUrl
 * returns the SAME { uploadUrl, objectKey, expiresAt } shape the presign
 * endpoint already returned — only now uploadUrl points at this backend's own
 * StorageController (PUT /storage/:key) instead of R2's S3 endpoint.
 */
@Injectable()
export class LocalStorageAdapter implements IObjectStorage {
  private readonly logger = new Logger(LocalStorageAdapter.name);
  private readonly signingSecret: string;
  private readonly publicBaseUrl: string;
  readonly storageDir: string;

  constructor(config: ConfigService) {
    this.storageDir = resolveStorageDir(config);
    this.publicBaseUrl = (config.get<string>('PUBLIC_BASE_URL') ?? 'http://localhost:3000').replace(
      /\/+$/,
      '',
    );

    const configured = config.get<string>('STORAGE_SIGNING_SECRET') ?? '';
    if (configured) {
      this.signingSecret = configured;
    } else {
      // Per-boot random fallback: mint and verify both happen in THIS process,
      // so a process-local secret keeps local dev working without editing
      // .env, and the secret never leaves the process. Loud warn so it is
      // obvious in prod logs that a stable STORAGE_SIGNING_SECRET is unset.
      this.signingSecret = randomBytes(32).toString('hex');
      this.logger.warn(
        'LocalStorageAdapter: STORAGE_SIGNING_SECRET is empty — using a per-boot random secret (set a stable value in production).',
      );
    }

    // Create the storage dir at boot if missing.
    fs.mkdirSync(this.storageDir, { recursive: true });
    this.logger.log(`LocalStorageAdapter: storing evidence under ${this.storageDir}`);
  }

  private sign(key: string, exp: number): string {
    return createHmac('sha256', this.signingSecret).update(`${key}:${exp}`).digest('hex');
  }

  async getUploadUrl({ key }: GetUploadUrlParams): Promise<UploadUrlResult> {
    const exp = Math.floor(Date.now() / 1000) + PRESIGN_TTL_SECONDS;
    const sig = this.sign(key, exp);
    const uploadUrl = `${this.publicBaseUrl}/storage/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`;

    return {
      uploadUrl,
      objectKey: key,
      expiresAt: new Date(exp * 1000),
    };
  }

  getPublicUrl(key: string): string {
    return `${this.publicBaseUrl}/storage/${encodeURIComponent(key)}`;
  }

  /** True if the epoch-seconds expiry has passed. */
  isExpired(exp: string | number): boolean {
    const expNum = Number(exp);
    return !Number.isFinite(expNum) || expNum * 1000 < Date.now();
  }

  /**
   * Constant-time verification of a signed PUT URL. Returns false (never
   * throws) for a tampered key, tampered signature, mismatched length, or a
   * malformed signature.
   */
  verifyUploadSignature(key: string, exp: string | number, sig: string): boolean {
    const expected = this.sign(key, Number(exp));
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(sig ?? '', 'utf8');
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /**
   * Resolves a storage key to an absolute path INSIDE the storage dir,
   * throwing on any path-traversal attempt (`..`, absolute keys, null bytes).
   * The read path (GET /storage/:key) is public and unsigned, so this guard is
   * the sole defense against a crafted key escaping the storage root.
   */
  resolvePath(key: string): string {
    if (!key || key.includes('\0')) {
      throw new Error('invalid storage key');
    }
    const base = path.resolve(this.storageDir);
    const target = path.resolve(base, key);
    if (target !== base && !target.startsWith(base + path.sep)) {
      throw new Error('storage key escapes the storage root');
    }
    return target;
  }
}
