import { IsOptional, IsString, IsUUID } from 'class-validator';

/**
 * PayEntryDto — POST /participants/me/pay body.
 * D-06: keyed on challengeId + the authenticated @CurrentUser(), no invite token.
 * D-17: pixKey is optional at pay time, captured for the eventual refund queue.
 */
export class PayEntryDto {
  @IsUUID()
  challengeId!: string;

  @IsOptional()
  @IsString()
  pixKey?: string;
}
