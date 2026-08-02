import { NotificationType } from '../../generated/prisma/client.js';
import { PushNotificationRow } from './push-copy.config';

/**
 * push-preview.fixtures.ts — synthetic `notification` rows for the admin
 * push-test dry-run bench (Quick task 260802-by6). Each row is plausible
 * (no empty field) and carries every property that type's `buildPayload`
 * in `push-copy.config.ts` reads, so `PushAdminService` can call the real
 * `buildPayload` against a mocked `PrismaService` without special-casing
 * any type beyond `EVIDENCE_REMINDER` (which has no `buildPayload` at all
 * by design, D12-02).
 *
 * `PUSH_PREVIEW_FIXTURES` is typed as a complete `Record<NotificationType,
 * ...>` on purpose — a 10th `NotificationType` fails compilation here until
 * it gets a fixture entry, mirroring the same discipline
 * `PUSH_CONFIG_BY_TYPE` already enforces.
 *
 * `EVIDENCE_SUBMITTED`'s preview always renders the count=1 ("singular")
 * copy — the real count comes from `notification.count` at send time
 * (D12-02/D12-05 "send-time-count"), and the dry-run's mocked Prisma
 * returns 0 rows, which `buildPayload` floors back up to 1 itself.
 *
 * `EVIDENCE_REMINDER` intentionally maps to `[]` — see `EVIDENCE_REMINDER
 * _PREVIEW` below, which drives its two variants through
 * `PushSenderService.buildEvidenceReminderPayload` instead. The
 * single-challenge preview uses `fallbackTitle` because the synthetic id
 * does not exist in the database — that keeps the dry-run entirely
 * database-independent.
 */

/** A fixed instant so previews are deterministic across test runs. */
const FIXTURE_CREATED_AT = new Date('2026-08-02T12:00:00Z');

export interface PushPreviewFixture {
  variant: string;
  row: PushNotificationRow;
}

export const PUSH_PREVIEW_FIXTURES: Record<NotificationType, PushPreviewFixture[]> = {
  INVITE_RECEIVED: [
    {
      variant: 'default',
      row: {
        id: 'preview-invite-received',
        userId: 'preview-user',
        type: 'INVITE_RECEIVED',
        entityId: 'preview-invite-token',
        payload: { inviterName: 'Ana', challengeTitle: 'Corrida matinal' },
        createdAt: FIXTURE_CREATED_AT,
      },
    },
  ],

  PAYMENT_CONFIRMED: [
    {
      variant: 'default',
      row: {
        id: 'preview-payment-confirmed',
        userId: 'preview-user',
        type: 'PAYMENT_CONFIRMED',
        entityId: 'preview-payment-1',
        payload: {
          challengeId: 'preview-challenge-1',
          challengeTitle: 'Corrida matinal',
          payerName: 'Bruno',
        },
        createdAt: FIXTURE_CREATED_AT,
      },
    },
  ],

  /**
   * PIT-3: `challengeId` MUST be non-empty — `buildPayload` filters
   * `notification.count` by `payload.challengeId` in the mocked Prisma
   * call, and an empty string would still run (read-only, safe in dry-run)
   * but would be a useless query in the eventual real send path.
   */
  EVIDENCE_SUBMITTED: [
    {
      variant: 'default',
      row: {
        id: 'preview-evidence-submitted',
        userId: 'preview-user',
        type: 'EVIDENCE_SUBMITTED',
        entityId: 'preview-evidence-1',
        payload: {
          challengeId: 'preview-challenge-1',
          challengeTitle: 'Corrida matinal',
        },
        createdAt: FIXTURE_CREATED_AT,
      },
    },
  ],

  EVIDENCE_VALIDATED: [
    {
      variant: 'default',
      row: {
        id: 'preview-evidence-validated',
        userId: 'preview-user',
        type: 'EVIDENCE_VALIDATED',
        entityId: 'preview-evidence-2',
        payload: {
          challengeId: 'preview-challenge-1',
          weekdayLabel: 'segunda',
          totalValidatedDays: 5,
        },
        createdAt: FIXTURE_CREATED_AT,
      },
    },
  ],

  // D12-02 — no row-based buildPayload; see EVIDENCE_REMINDER_PREVIEW below.
  EVIDENCE_REMINDER: [],

  /** QT-04: two variants with DISTINCT `entityId` so tags never collapse. */
  CHALLENGE_FINALIZED: [
    {
      variant: 'vencedor',
      row: {
        id: 'preview-challenge-finalized-vencedor',
        userId: 'preview-user',
        type: 'CHALLENGE_FINALIZED',
        entityId: 'preview-challenge-finalized-vencedor',
        payload: {
          challengeId: 'preview-challenge-1',
          challengeTitle: 'Corrida matinal',
          isCurrentUserWinner: true,
          prizeAmount: '450,00',
          winnerName: 'Ana',
        },
        createdAt: FIXTURE_CREATED_AT,
      },
    },
    {
      variant: 'nao-vencedor',
      row: {
        id: 'preview-challenge-finalized-nao-vencedor',
        userId: 'preview-user',
        type: 'CHALLENGE_FINALIZED',
        entityId: 'preview-challenge-finalized-nao-vencedor',
        payload: {
          challengeId: 'preview-challenge-1',
          challengeTitle: 'Corrida matinal',
          isCurrentUserWinner: false,
          prizeAmount: '450,00',
          winnerName: 'Ana',
        },
        createdAt: FIXTURE_CREATED_AT,
      },
    },
  ],

  CHALLENGE_CANCELLED: [
    {
      variant: 'default',
      row: {
        id: 'preview-challenge-cancelled',
        userId: 'preview-user',
        type: 'CHALLENGE_CANCELLED',
        entityId: 'preview-challenge-2',
        payload: {
          challengeId: 'preview-challenge-2',
          challengeTitle: 'Corrida matinal',
        },
        createdAt: FIXTURE_CREATED_AT,
      },
    },
  ],

  CHALLENGE_ACTIVATED: [
    {
      variant: 'default',
      row: {
        id: 'preview-challenge-activated',
        userId: 'preview-user',
        type: 'CHALLENGE_ACTIVATED',
        entityId: 'preview-challenge-3',
        payload: {
          challengeId: 'preview-challenge-3',
          challengeTitle: 'Corrida matinal',
        },
        createdAt: FIXTURE_CREATED_AT,
      },
    },
  ],

  EVIDENCE_REJECTED: [
    {
      variant: 'default',
      row: {
        id: 'preview-evidence-rejected',
        userId: 'preview-user',
        type: 'EVIDENCE_REJECTED',
        entityId: 'preview-evidence-3',
        payload: {
          challengeId: 'preview-challenge-1',
          weekdayLabel: 'terça',
        },
        createdAt: FIXTURE_CREATED_AT,
      },
    },
  ],
};

/**
 * `EVIDENCE_REMINDER` synthetic inputs for
 * `PushSenderService.buildEvidenceReminderPayload` (PIT-1) — the single-
 * challenge variant uses `fallbackTitle` because `singleChallengeIds`'s id
 * does not exist in the database, keeping the dry-run preview entirely
 * independent of Prisma state. `multiChallengeIds` has 3 ids because the
 * aggregate branch never queries the database at all, so it renders
 * identically in dry-run and in a real send — it also doubles as the
 * synthetic id list `PushAdminService` sends when a real-send caller omits
 * `challengeIds` (compat: the legacy caller's own ids always win, QT-01).
 */
export const EVIDENCE_REMINDER_PREVIEW = {
  fallbackTitle: 'Corrida matinal',
  singleChallengeIds: ['preview-challenge-reminder-single'],
  multiChallengeIds: [
    'preview-challenge-reminder-1',
    'preview-challenge-reminder-2',
    'preview-challenge-reminder-3',
  ],
};
