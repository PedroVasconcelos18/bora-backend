import { IsOptional, IsString } from 'class-validator';

/**
 * UpdateProfileDto — PATCH /profile body.
 * D-4: free text, trim-only. No CPF/email/phone/random validation.
 */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  pixKey?: string;
}
