import { ArrayMaxSize, IsArray, IsOptional, IsString } from 'class-validator';
import { MAX_PIX_KEYS } from '../profile.service';

/**
 * UpdateProfileDto — PATCH /profile body.
 * D-4: free text, trim-only. No CPF/email/phone/random validation.
 *
 * `pixKeys` is the current shape (up to MAX_PIX_KEYS keys). `pixKey` stays
 * accepted as a legacy single-key fallback so older clients don't break.
 */
export class UpdateProfileDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PIX_KEYS)
  @IsString({ each: true })
  pixKeys?: string[];

  @IsOptional()
  @IsString()
  pixKey?: string;
}
