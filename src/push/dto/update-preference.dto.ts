import { IsBoolean, IsEnum } from 'class-validator';
import { NotificationType } from '../../generated/prisma/client.js';

/**
 * POST /push/preferences body.
 *
 * `@IsEnum(NotificationType)` is the barrier that keeps any string outside
 * the 9 known types from ever reaching Prisma — the global `ValidationPipe`
 * (main.ts) also runs with `whitelist`/`forbidNonWhitelisted`, so an extra
 * field (like a smuggled `userId`) is rejected too, before this DTO's
 * fields are even considered.
 */
export class UpdatePreferenceDto {
  @IsEnum(NotificationType)
  type!: NotificationType;

  @IsBoolean()
  enabled!: boolean;
}
