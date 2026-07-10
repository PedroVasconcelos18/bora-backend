import { IsIn } from 'class-validator';

/**
 * CastVoteDto — POST /evidences/:id/votes body.
 * `value` is enum-backed (never a free string) per RESEARCH.md Security
 * Domain V5 / Known Threat Pattern "vote value" (T-03-12).
 */
export class CastVoteDto {
  @IsIn(['SIM', 'NAO'])
  value!: 'SIM' | 'NAO';
}
