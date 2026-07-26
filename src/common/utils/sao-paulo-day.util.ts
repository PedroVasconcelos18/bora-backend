// Verified by direct execution against the Node runtime in this environment
// (RESEARCH.md §"SP-day-boundary utility"): confirms correct UTC -> America/Sao_Paulo
// day-boundary resolution with zero new dependencies. Brazil has had no DST
// since 2019 but this uses the IANA zone (not a hardcoded -3 offset) so it stays
// correct if that ever changes (Pitfall 3).
const SP_DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Returns the America/Sao_Paulo calendar day for `date` as 'YYYY-MM-DD'.
 * The single source of truth for the SP calendar-day string — used by the
 * evidence one-per-day gate (EVID-03) and reused by the ranking/streak-grid
 * day-index computation (Plan 06), so the two can never disagree about which
 * calendar day a given instant falls on.
 */
export function saoPauloDay(date: Date = new Date()): string {
  return SP_DAY_FORMATTER.format(date);
}

/**
 * Returns the exact instant of 23:59:59.999 in America/Sao_Paulo for the given
 * 'YYYY-MM-DD' calendar day. This is the vote-window close for an evidence
 * posted on `dayStr` (item G — cada evidência fecha às 23:59 SP do próprio dia).
 *
 * Uses the fixed -03:00 offset: Brazil has had no DST since 2019, so SP is a
 * constant UTC-3 and the offset is unambiguous for this end-of-day boundary
 * (e.g. 2026-07-18 -> 2026-07-19T02:59:59.999Z).
 */
export function saoPauloEndOfDay(dayStr: string): Date {
  return new Date(`${dayStr}T23:59:59.999-03:00`);
}

/**
 * Returns the exact instant of 00:00:00.000 in America/Sao_Paulo for the given
 * 'YYYY-MM-DD' calendar day (e.g. 2026-07-29 -> 2026-07-29T03:00:00.000Z).
 *
 * Why this exists: `new Date('2026-07-29')` yields UTC midnight, which in SP is
 * 21:00 of the PREVIOUS day. Persisting that as `Challenge.startsAt` made every
 * SP-calendar derivation slip one day back — the ranking's day 1 landed on the
 * eve of the start date (marked `falhou` for everyone, since nobody could have
 * posted), the activation gate opened 3h early, and the countdown label
 * rendered the day before the one the creator picked.
 *
 * Same fixed -03:00 offset rationale as saoPauloEndOfDay: no DST in Brazil
 * since 2019, so the start-of-day boundary is unambiguous.
 */
export function saoPauloStartOfDay(dayStr: string): Date {
  return new Date(`${dayStr}T00:00:00.000-03:00`);
}
