import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** POST /admin/push/test body — operator-only manual trigger (Discretion #5). */
export class AdminTestPushDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  challengeIds?: string[];
}
