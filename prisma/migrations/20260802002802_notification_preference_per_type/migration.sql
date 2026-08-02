-- D12-07: NotificationPreference goes from "one boolean row per user" to
-- "one row per (user, type), only for deviations from that type's default".
-- The two new columns are added nullable first so the table can carry
-- existing rows through the migration, then explicit opt-outs are preserved
-- as EVIDENCE_REMINDER overrides, everything else is dropped, and only then
-- do the columns become NOT NULL and the old boolean column disappears.
-- Order matters: the preservation UPDATE below must run while
-- push_reminders_enabled still exists.

-- DropIndex
DROP INDEX "notification_preferences_user_id_key";

-- AlterTable: add the new columns nullable — rows may already exist.
ALTER TABLE "notification_preferences" ADD COLUMN "type" "NotificationType";
ALTER TABLE "notification_preferences" ADD COLUMN "enabled" BOOLEAN;

-- Preserve only real deviations. In the Phase 11 code, push_reminders_enabled
-- was set to false at the exact moment a user's LAST PushSubscription was
-- removed (see the pre-migration PushService.deleteSubscription) — so a
-- `false` row alone does not distinguish "the person chose to turn the
-- reminder off" from "the person just removed the app from their device".
-- The signal D12-07 authorizes to tell them apart is subscription
-- existence: a `false` row WITH a live PushSubscription cannot be explained
-- by the removal path above, so it is treated as an explicit opt-out and
-- carried forward as an EVIDENCE_REMINDER override (the only push type that
-- existed pre-Phase-12, so it is the only type this history can refer to).
UPDATE "notification_preferences" SET "type" = 'EVIDENCE_REMINDER', "enabled" = false
WHERE "push_reminders_enabled" = false
  AND EXISTS (
    SELECT 1 FROM "push_subscriptions" ps WHERE ps."user_id" = "notification_preferences"."user_id"
  );

-- Discard everything else. Two cases, both correct to drop:
--   - `true` rows: redundant, because EVIDENCE_REMINDER's new default is
--     already enabled — keeping a row equal to the default would break the
--     "absence of a row means the default" invariant.
--   - `false` rows with NO live subscription: inert today (the subscription
--     gate blocks them regardless), and carrying them forward would silently
--     re-disable the reminder for someone who re-subscribes later, which
--     they never chose in the per-type model.
DELETE FROM "notification_preferences" WHERE "enabled" IS NULL;

-- AlterTable: now that every remaining row has both values, tighten them.
ALTER TABLE "notification_preferences" ALTER COLUMN "type" SET NOT NULL;
ALTER TABLE "notification_preferences" ALTER COLUMN "enabled" SET NOT NULL;
ALTER TABLE "notification_preferences" DROP COLUMN "push_reminders_enabled";

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_user_id_type_key" ON "notification_preferences"("user_id", "type");
