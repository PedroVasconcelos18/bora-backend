import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  GetUploadUrlParams,
  IObjectStorage,
  UploadUrlResult,
} from '../interfaces/object-storage.interface';

// A3 (RESEARCH.md Assumptions Log): expiresIn: 600 (10 min) — short-lived TTL,
// the client PUTs almost immediately after minting, and a short window limits
// exposure if a presigned URL is ever leaked or replayed after the
// participant's paid status changes mid-window.
const PRESIGN_TTL_SECONDS = 600; // 10 minutes

/**
 * R2Adapter implements IObjectStorage using the S3-compatible AWS SDK against
 * Cloudflare R2 (region: 'auto', R2's own S3-API endpoint).
 *
 * Mirrors MercadoPagoAdapter's unconfigured-mode pattern: construction never
 * throws (the app must still boot when R2 env vars are absent, e.g. before
 * the Task 4 provisioning checkpoint), but getUploadUrl throws immediately if
 * the client was never configured — never silently fakes a presigned URL.
 */
@Injectable()
export class R2Adapter implements IObjectStorage {
  private readonly logger = new Logger(R2Adapter.name);
  private readonly client: S3Client | null;
  private readonly defaultBucket: string;

  constructor(private readonly config: ConfigService) {
    const accountId = this.config.get<string>('R2_ACCOUNT_ID') ?? '';
    const accessKeyId = this.config.get<string>('R2_ACCESS_KEY_ID') ?? '';
    const secretAccessKey = this.config.get<string>('R2_SECRET_ACCESS_KEY') ?? '';
    this.defaultBucket = this.config.get<string>('R2_BUCKET_NAME') ?? '';

    if (accountId && accessKeyId && secretAccessKey && this.defaultBucket) {
      this.client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
      });
      this.logger.log('R2Adapter: configured (R2_* env vars present)');
    } else {
      this.client = null;
      this.logger.warn(
        'R2Adapter: R2_* env vars missing — getUploadUrl will throw (no upload URL can be faked)',
      );
    }
  }

  async getUploadUrl({ bucket, key, contentType }: GetUploadUrlParams): Promise<UploadUrlResult> {
    if (!this.client) {
      throw new Error('R2Adapter: cannot mint an upload URL — R2_* env vars are not configured');
    }

    const targetBucket = bucket ?? this.defaultBucket;

    let uploadUrl: string;
    try {
      uploadUrl = await getSignedUrl(
        this.client,
        new PutObjectCommand({ Bucket: targetBucket, Key: key, ContentType: contentType }),
        { expiresIn: PRESIGN_TTL_SECONDS },
      );
    } catch (err) {
      this.logger.error(
        `R2Adapter.getUploadUrl: failed to sign PUT for key=${key}: ${
          err instanceof Error ? err.stack ?? err.message : String(err)
        }`,
      );
      throw new Error('R2Adapter: failed to mint a presigned upload URL');
    }

    return {
      uploadUrl,
      objectKey: key,
      expiresAt: new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000),
    };
  }
}
