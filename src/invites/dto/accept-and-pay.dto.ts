import { IsOptional, IsString } from 'class-validator';

/**
 * AcceptAndPayDto — POST /invites/:token/accept-and-pay body.
 * D-17: pixKey is optional at pay time, captured for the eventual refund queue.
 */
export class AcceptAndPayDto {
  @IsOptional()
  @IsString()
  pixKey?: string;
}
