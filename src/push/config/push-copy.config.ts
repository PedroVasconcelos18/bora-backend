import { NotificationType } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service';
import { saoPauloDay, saoPauloStartOfDay } from '../../common/utils/sao-paulo-day.util';

/**
 * push-copy.config.ts — the ONLY place where per-type lock-screen copy
 * (D12-03), push default enablement (D12-04) and coalescing strategy
 * (D12-05) live for all 9 `NotificationType` members. `PushSenderService`
 * and `PushListener` read this map; neither one hard-codes a title, body,
 * tap-URL, tag or default anywhere else.
 *
 * Tone mirrors `bora-frontend/src/lib/notifications.ts`'s `renderCopy`
 * switch (same second-person-implied register, same emoji-per-type
 * vocabulary via `EMOJI_BY_TYPE`) but never copies its literal text: that
 * module's `→` list affordance is meaningless on a lock screen, and its
 * sentences describe an already-happened event in a different tense than
 * a push notification wants. The two copies stay in sync on tone, not text
 * — exactly what Phase 11 already did for `EVIDENCE_REMINDER`.
 *
 * Adding a 10th `NotificationType` means adding one entry to
 * `PUSH_CONFIG_BY_TYPE` below — nothing else in the push pipeline should
 * need to change.
 */

/** The frozen `sw.js` payload contract (SC-4) — exactly these four keys. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/**
 * Structural shape of the `notification` row the funnel emits. `payload` is
 * `unknown` on purpose: it accepts whatever `Prisma.JsonValue` the generated
 * client hands back without forcing a cast at every call site.
 */
export interface PushNotificationRow {
  id: string;
  userId: string;
  type: NotificationType;
  entityId: string;
  payload: unknown;
  createdAt: Date;
}

/**
 * What a `buildPayload` needs beyond the row itself. Only `EVIDENCE_SUBMITTED`
 * uses it today (to count same-day, same-challenge rows at send time) — a
 * single field keeps the map a plain data structure instead of turning into
 * a Nest service.
 */
export interface PushCopyContext {
  prisma: PrismaService;
}

/**
 * How a type's pushes are grouped before they leave the server (D12-05).
 * Absence of `coalesce` on a `PushTypeConfig` means "send immediately, no
 * grouping" — the OS-level `tag` still collapses same-tag repeats on the
 * device, but that is a separate, complementary mechanism (see D12-05).
 */
export type PushCoalesceStrategy = 'evidence-reminder-window' | 'send-time-count';

export interface PushTypeConfig {
  /** D12-04 — the value `PushService.getPushTargets` falls back to when no
   * `NotificationPreference` override row exists for (userId, type). */
  defaultEnabled: boolean;
  /** D12-05 — declared grouping strategy; undefined = send direct. */
  coalesce?: PushCoalesceStrategy;
  buildPayload: (
    row: PushNotificationRow,
    ctx: PushCopyContext,
  ) => PushPayload | Promise<PushPayload>;
}

/** Reads the row's JSON payload as a plain object, never `any`. */
function payloadOf(row: PushNotificationRow): Record<string, unknown> {
  return (row.payload ?? {}) as Record<string, unknown>;
}

export const PUSH_CONFIG_BY_TYPE: Record<NotificationType, PushTypeConfig> = {
  INVITE_RECEIVED: {
    defaultEnabled: true,
    buildPayload: (row) => {
      const p = payloadOf(row);
      return {
        title: '🏃 Bora',
        body: `${String(p.inviterName)} te convidou pro ${String(p.challengeTitle)}`,
        // The entityId of this type IS the invite token, same as
        // `buildDeepLink`'s INVITE_RECEIVED branch.
        url: `/invites/${row.entityId}`,
        tag: `invite-received-${row.entityId}`,
      };
    },
  },

  PAYMENT_CONFIRMED: {
    defaultEnabled: true,
    buildPayload: (row) => {
      const p = payloadOf(row);
      const challengeId = String(p.challengeId ?? '');
      return {
        title: '💸 Bora',
        body: `Pagamento de ${String(p.payerName)} confirmado no ${String(p.challengeTitle)}`,
        url: `/challenges/${challengeId}`,
        tag: `payment-confirmed-${row.entityId}`,
      };
    },
  },

  /**
   * The only type that nasce disabled by default (D12-04) — fan-out per
   * participant, the exact volume problem that got this type cut from
   * Phase 11 (D-04 there). The body aggregates by counting how many
   * `EVIDENCE_SUBMITTED` rows this user already has today for this same
   * challenge — no queue, no timer (D12-02/D12-05 "send-time-count").
   * The tag is stable per (challenge, day): that is the device-level
   * mechanism that makes the OS REPLACE the lock-screen banner silently
   * instead of stacking it. `renotify` is deliberately never set anywhere
   * in this pipeline (`sw.js` already omits it, and this type's own
   * default is off) — a silent replace is the right feel for a type most
   * people never turn on.
   */
  EVIDENCE_SUBMITTED: {
    defaultEnabled: false,
    coalesce: 'send-time-count',
    buildPayload: async (row, ctx) => {
      const p = payloadOf(row);
      const challengeId = String(p.challengeId ?? '');
      const challengeTitle = String(p.challengeTitle ?? '');
      const day = saoPauloDay();

      // The row that triggered this event is already persisted, so it
      // counts itself — the real floor is 1. Any query failure degrades to
      // the singular copy instead of throwing (fire-and-forget, D-03 of
      // Phase 11: a degraded push beats no push).
      let count = 1;
      try {
        count = await ctx.prisma.notification.count({
          where: {
            userId: row.userId,
            type: 'EVIDENCE_SUBMITTED',
            createdAt: { gte: saoPauloStartOfDay(day) },
            payload: { path: ['challengeId'], equals: challengeId },
          },
        });
        if (count < 1) {
          count = 1;
        }
      } catch {
        count = 1;
      }

      const body =
        count > 1
          ? `${count} pessoas postaram evidência hoje no ${challengeTitle}`
          : `Nova evidência esperando seu voto no ${challengeTitle}`;

      return {
        title: '🗳️ Bora',
        body,
        // Mirrors `buildDeepLink`'s EVIDENCE_SUBMITTED branch.
        url: `/challenges/${challengeId}?panel=votar`,
        tag: `evidence-submitted-${challengeId}-${day}`,
      };
    },
  },

  EVIDENCE_VALIDATED: {
    defaultEnabled: true,
    buildPayload: (row) => {
      const p = payloadOf(row);
      const challengeId = String(p.challengeId ?? '');
      return {
        title: '✅ Bora',
        body: `Sua evidência de ${String(p.weekdayLabel)} foi validada — ${Number(p.totalValidatedDays)} dias no total 💪`,
        url: `/challenges/${challengeId}`,
        tag: `evidence-validated-${row.entityId}`,
      };
    },
  },

  /**
   * D12-02: this type's payload is NOT built from a single row — it is
   * built by `PushSenderService.sendEvidenceReminder` from the coalesced,
   * cross-challenge list `PushListener`'s window accumulates. The aggregate
   * body ("N desafios esperando evidência") is a hard requirement that does
   * not fit a one-row `buildPayload` signature, so this entry exists only
   * to declare the default/coalesce strategy and to fail loudly if anything
   * ever calls it directly.
   */
  EVIDENCE_REMINDER: {
    defaultEnabled: true,
    coalesce: 'evidence-reminder-window',
    buildPayload: () => {
      throw new Error(
        'EVIDENCE_REMINDER payload is built by PushSenderService.sendEvidenceReminder ' +
          'from the coalesced challenge list, never from a single notification row (D12-02).',
      );
    },
  },

  CHALLENGE_FINALIZED: {
    defaultEnabled: true,
    buildPayload: (row) => {
      const p = payloadOf(row);
      const challengeId = String(p.challengeId ?? '');
      const challengeTitle = String(p.challengeTitle ?? '');
      const body = p.isCurrentUserWinner
        ? `Você levou o prêmio de R$ ${String(p.prizeAmount)} no ${challengeTitle}! 🎉`
        : `${challengeTitle} terminou — ${String(p.winnerName)} levou o prêmio`;
      return {
        title: '🏆 Bora',
        body,
        // Mirrors `buildDeepLink`'s CHALLENGE_FINALIZED branch.
        url: `/challenges/${challengeId}?panel=ranking`,
        tag: `challenge-finalized-${row.entityId}`,
      };
    },
  },

  CHALLENGE_CANCELLED: {
    defaultEnabled: true,
    buildPayload: (row) => {
      const p = payloadOf(row);
      const challengeId = String(p.challengeId ?? '');
      return {
        title: '😕 Bora',
        body: `${String(p.challengeTitle)} foi cancelado — seu reembolso está a caminho`,
        url: `/challenges/${challengeId}`,
        tag: `challenge-cancelled-${row.entityId}`,
      };
    },
  },

  CHALLENGE_ACTIVATED: {
    defaultEnabled: true,
    buildPayload: (row) => {
      const p = payloadOf(row);
      const challengeId = String(p.challengeId ?? '');
      return {
        title: '🚀 Bora',
        body: `${String(p.challengeTitle)} começou! Bora postar a primeira evidência`,
        url: `/challenges/${challengeId}`,
        tag: `challenge-activated-${row.entityId}`,
      };
    },
  },

  EVIDENCE_REJECTED: {
    defaultEnabled: true,
    buildPayload: (row) => {
      const p = payloadOf(row);
      const challengeId = String(p.challengeId ?? '');
      return {
        title: '❌ Bora',
        body: `Sua evidência de ${String(p.weekdayLabel)} não foi validada — bora tentar de novo amanhã`,
        url: `/challenges/${challengeId}`,
        tag: `evidence-rejected-${row.entityId}`,
      };
    },
  },
};
