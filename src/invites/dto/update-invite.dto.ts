import { IsEmail } from 'class-validator';

/**
 * UpdateInviteDto — PATCH /invites/:id body (feedback QA 5a).
 * Creator edits a pending invite's target email; validated as a real email,
 * same rule as the create-challenge invitees list.
 */
export class UpdateInviteDto {
  @IsEmail()
  targetEmail!: string;
}
