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
