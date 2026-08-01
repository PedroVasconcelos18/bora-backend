import { IsNotEmpty, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * The two Web Push encryption keys the browser hands back inside
 * `PushSubscription.toJSON().keys`. Both are opaque base64url strings — no
 * further shape validation beyond "non-empty string".
 */
export class PushKeysDto {
  @IsString()
  @IsNotEmpty()
  p256dh!: string;

  @IsString()
  @IsNotEmpty()
  auth!: string;
}

/**
 * POST /push/subscriptions body.
 *
 * The global ValidationPipe runs with `forbidNonWhitelisted: true` (main.ts),
 * so the browser's raw `PushSubscription.toJSON()` cannot be posted as-is —
 * it also carries an `expirationTime` field this DTO does not declare. The
 * client must send only `endpoint` and `keys.p256dh`/`keys.auth` and drop
 * everything else the browser adds (Plan 11-07 implements that client half).
 *
 * `endpoint` is deliberately NOT `@IsUrl()`: push service endpoints are
 * opaque URLs (e.g. Apple's web push gateway) that the strict URL validator
 * rejects as malformed even though they are legitimate.
 */
export class CreateSubscriptionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  endpoint!: string;

  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;
}

/** POST /push/subscriptions/unsubscribe body. */
export class UnsubscribeDto {
  @IsString()
  @IsNotEmpty()
  endpoint!: string;
}
