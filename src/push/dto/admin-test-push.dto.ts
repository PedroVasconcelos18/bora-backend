import { IsArray, IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { NotificationType } from '../../generated/prisma/client.js';

export const ADMIN_TEST_PUSH_TYPES = [...Object.values(NotificationType), 'ALL'] as const;

export type AdminTestPushType = NotificationType | 'ALL';

/**
 * POST /admin/push/test body — operator-only manual trigger (Discretion #5),
 * generalized by Quick task 260802-by6 into a per-`NotificationType`
 * preview/send bench (D-01).
 *
 * The ABSENCE of `type` means `EVIDENCE_REMINDER` on purpose — the original
 * `{userId, challengeIds}` caller shape keeps triggering exactly the daily
 * evidence reminder it always did, with the same body (QT-01). The ABSENCE
 * of `dryRun` means a real send: nothing here is "safe by default", the
 * operator must opt INTO preview mode with `dryRun: true`.
 */
export class AdminTestPushDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  challengeIds?: string[];

  @IsOptional()
  @IsIn(ADMIN_TEST_PUSH_TYPES)
  type?: AdminTestPushType;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
