-- Data-only migration: `challenges.starts_at` was persisted as UTC midnight of
-- the chosen calendar day (`new Date('2026-07-29')` -> 2026-07-29T00:00:00Z).
-- In America/Sao_Paulo that instant is 21:00 of the PREVIOUS day, so every
-- SP-calendar derivation slipped one day back:
--   * ranking day 1 landed on the eve of the start date and rendered `falhou`
--     for the whole turma (nobody could post evidence on a day before the start);
--   * the activation gate (payments.service) opened 3h early;
--   * the countdown label showed the day before the creator's chosen date.
--
-- The code now writes `saoPauloStartOfDay(startDate)` (= 03:00:00Z). This
-- realigns the rows written before that fix.
--
-- Predicate is exact-UTC-midnight only, so rows already stored at 03:00Z (or any
-- other time) are untouched. Idempotent by construction: after the UPDATE no row
-- satisfies the predicate anymore.
UPDATE "challenges"
SET "starts_at" = "starts_at" + INTERVAL '3 hours'
WHERE "starts_at" IS NOT NULL
  AND "starts_at" = date_trunc('day', "starts_at");
