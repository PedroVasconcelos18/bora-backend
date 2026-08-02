import { NotificationType } from '../../generated/prisma/client.js';
import {
  PUSH_CONFIG_BY_TYPE,
  PushCopyContext,
  PushNotificationRow,
} from './push-copy.config';

// Local copy of the glyph-per-type vocabulary this config mirrors (D12-03).
// Not imported from `bora-frontend` — the two repos are separate git repos
// with no shared package (D12-03's own rationale) — kept here only to
// assert titles start with the right glyph.
const EMOJI_BY_TYPE: Record<NotificationType, string> = {
  INVITE_RECEIVED: '🏃',
  PAYMENT_CONFIRMED: '💸',
  EVIDENCE_SUBMITTED: '🗳️',
  EVIDENCE_VALIDATED: '✅',
  EVIDENCE_REMINDER: '📸',
  CHALLENGE_FINALIZED: '🏆',
  CHALLENGE_CANCELLED: '😕',
  CHALLENGE_ACTIVATED: '🚀',
  EVIDENCE_REJECTED: '❌',
};

const ALL_TYPES: NotificationType[] = [
  'INVITE_RECEIVED',
  'PAYMENT_CONFIRMED',
  'EVIDENCE_SUBMITTED',
  'EVIDENCE_VALIDATED',
  'EVIDENCE_REMINDER',
  'CHALLENGE_FINALIZED',
  'CHALLENGE_CANCELLED',
  'CHALLENGE_ACTIVATED',
  'EVIDENCE_REJECTED',
];

function buildRow(
  type: NotificationType,
  entityId: string,
  payload: Record<string, unknown>,
): PushNotificationRow {
  return {
    id: 'notif-1',
    userId: 'user-1',
    type,
    entityId,
    payload,
    createdAt: new Date('2026-08-01T12:00:00.000Z'),
  };
}

function makeCtx(count: jest.Mock): PushCopyContext {
  return {
    prisma: { notification: { count } } as unknown as PushCopyContext['prisma'],
  };
}

// One fixture per type, shaped exactly like the payload
// `notifications.listener.ts` writes for that type today.
const FIXTURES: Record<
  Exclude<NotificationType, 'EVIDENCE_REMINDER'>,
  { entityId: string; payload: Record<string, unknown> }
> = {
  INVITE_RECEIVED: {
    entityId: 'invite-token-1',
    payload: { inviterName: 'Ana', challengeTitle: 'Corrida matinal', amount: '20' },
  },
  PAYMENT_CONFIRMED: {
    entityId: 'payment-1',
    payload: {
      payerName: 'Bruno',
      challengeTitle: 'Corrida matinal',
      challengeId: 'challenge-1',
      missingCount: 2,
    },
  },
  EVIDENCE_SUBMITTED: {
    entityId: 'evidence-1',
    payload: { authorName: 'Carla', challengeTitle: 'Corrida matinal', challengeId: 'challenge-1' },
  },
  EVIDENCE_VALIDATED: {
    entityId: 'evidence-2',
    payload: {
      challengeTitle: 'Corrida matinal',
      challengeId: 'challenge-1',
      weekdayLabel: 'segunda-feira',
      totalValidatedDays: 5,
    },
  },
  CHALLENGE_FINALIZED: {
    entityId: 'challenge-1',
    payload: {
      challengeTitle: 'Corrida matinal',
      challengeId: 'challenge-1',
      winnerName: 'Diego',
      isCurrentUserWinner: false,
      prizeAmount: '150.00',
    },
  },
  CHALLENGE_CANCELLED: {
    entityId: 'challenge-1',
    payload: { challengeTitle: 'Corrida matinal', challengeId: 'challenge-1', reason: 'manual' },
  },
  CHALLENGE_ACTIVATED: {
    entityId: 'challenge-1',
    payload: { challengeTitle: 'Corrida matinal', challengeId: 'challenge-1' },
  },
  EVIDENCE_REJECTED: {
    entityId: 'evidence-3',
    payload: {
      challengeTitle: 'Corrida matinal',
      challengeId: 'challenge-1',
      weekdayLabel: 'terça-feira',
    },
  },
};

const TYPES_WITH_USABLE_BUILD_PAYLOAD = ALL_TYPES.filter(
  (type) => type !== 'EVIDENCE_REMINDER',
) as Array<Exclude<NotificationType, 'EVIDENCE_REMINDER'>>;

describe('PUSH_CONFIG_BY_TYPE', () => {
  it('has exactly the 9 NotificationType members, no more, no less', () => {
    const keys = Object.keys(PUSH_CONFIG_BY_TYPE).sort();
    expect(keys).toEqual([...ALL_TYPES].sort());
  });

  it('D12-04: defaultEnabled is false only for EVIDENCE_SUBMITTED, true for the other 8', () => {
    const disabled = ALL_TYPES.filter((type) => !PUSH_CONFIG_BY_TYPE[type].defaultEnabled);
    expect(disabled).toEqual(['EVIDENCE_SUBMITTED']);
  });

  it('D12-05: coalesce is declared per type — window for the reminder, count for submissions, none for the rest', () => {
    const coalesceByType = Object.fromEntries(
      ALL_TYPES.map((type) => [type, PUSH_CONFIG_BY_TYPE[type].coalesce]),
    );
    expect(coalesceByType).toEqual({
      INVITE_RECEIVED: undefined,
      PAYMENT_CONFIRMED: undefined,
      EVIDENCE_SUBMITTED: 'send-time-count',
      EVIDENCE_VALIDATED: undefined,
      EVIDENCE_REMINDER: 'evidence-reminder-window',
      CHALLENGE_FINALIZED: undefined,
      CHALLENGE_CANCELLED: undefined,
      CHALLENGE_ACTIVATED: undefined,
      EVIDENCE_REJECTED: undefined,
    });
  });

  describe('payload contract (SC-4)', () => {
    it.each(TYPES_WITH_USABLE_BUILD_PAYLOAD)('%s produces exactly {title, body, url, tag}', async (type) => {
      const fixture = FIXTURES[type];
      const row = buildRow(type, fixture.entityId, fixture.payload);
      const ctx = makeCtx(jest.fn().mockResolvedValue(1));

      const payload = await PUSH_CONFIG_BY_TYPE[type].buildPayload(row, ctx);

      expect(Object.keys(payload).sort()).toEqual(['body', 'tag', 'title', 'url']);
      expect(payload.title.startsWith(EMOJI_BY_TYPE[type])).toBe(true);
      expect(payload.title.endsWith('Bora')).toBe(true);
    });
  });

  describe('tap destinations', () => {
    it('INVITE_RECEIVED points at the invite route built from entityId', async () => {
      const fixture = FIXTURES.INVITE_RECEIVED;
      const row = buildRow('INVITE_RECEIVED', fixture.entityId, fixture.payload);
      const payload = await PUSH_CONFIG_BY_TYPE.INVITE_RECEIVED.buildPayload(row, makeCtx(jest.fn()));

      expect(payload.url).toBe(`/invites/${fixture.entityId}`);
    });

    it('EVIDENCE_SUBMITTED points at the challenge with the voting panel suffix', async () => {
      const fixture = FIXTURES.EVIDENCE_SUBMITTED;
      const row = buildRow('EVIDENCE_SUBMITTED', fixture.entityId, fixture.payload);
      const ctx = makeCtx(jest.fn().mockResolvedValue(1));

      const payload = await PUSH_CONFIG_BY_TYPE.EVIDENCE_SUBMITTED.buildPayload(row, ctx);

      expect(payload.url).toBe('/challenges/challenge-1?panel=votar');
    });

    it('CHALLENGE_FINALIZED points at the challenge with the ranking panel suffix', async () => {
      const fixture = FIXTURES.CHALLENGE_FINALIZED;
      const row = buildRow('CHALLENGE_FINALIZED', fixture.entityId, fixture.payload);
      const payload = await PUSH_CONFIG_BY_TYPE.CHALLENGE_FINALIZED.buildPayload(row, makeCtx(jest.fn()));

      expect(payload.url).toBe('/challenges/challenge-1?panel=ranking');
    });

    it.each(
      TYPES_WITH_USABLE_BUILD_PAYLOAD.filter(
        (type) => !['INVITE_RECEIVED', 'EVIDENCE_SUBMITTED', 'CHALLENGE_FINALIZED'].includes(type),
      ),
    )('%s points at the plain challenge route from payload.challengeId', async (type) => {
      const fixture = FIXTURES[type];
      const row = buildRow(type, fixture.entityId, fixture.payload);
      const payload = await PUSH_CONFIG_BY_TYPE[type].buildPayload(row, makeCtx(jest.fn()));

      expect(payload.url).toBe(`/challenges/${fixture.payload.challengeId}`);
    });
  });

  describe('CHALLENGE_FINALIZED body bifurcation', () => {
    it('cites the prize amount when the recipient is the winner', async () => {
      const row = buildRow('CHALLENGE_FINALIZED', 'challenge-1', {
        challengeTitle: 'Corrida matinal',
        challengeId: 'challenge-1',
        winnerName: 'Diego',
        isCurrentUserWinner: true,
        prizeAmount: '150.00',
      });

      const payload = await PUSH_CONFIG_BY_TYPE.CHALLENGE_FINALIZED.buildPayload(row, makeCtx(jest.fn()));

      expect(payload.body).toContain('150.00');
      expect(payload.body).not.toContain('Diego');
    });

    it('cites the winner name when the recipient did not win', async () => {
      const row = buildRow('CHALLENGE_FINALIZED', 'challenge-1', FIXTURES.CHALLENGE_FINALIZED.payload);

      const payload = await PUSH_CONFIG_BY_TYPE.CHALLENGE_FINALIZED.buildPayload(row, makeCtx(jest.fn()));

      expect(payload.body).toContain('Diego');
    });
  });

  describe('EVIDENCE_SUBMITTED (SC-5)', () => {
    it('renders the singular variant when the same-day count is 1', async () => {
      const row = buildRow('EVIDENCE_SUBMITTED', 'evidence-1', FIXTURES.EVIDENCE_SUBMITTED.payload);
      const ctx = makeCtx(jest.fn().mockResolvedValue(1));

      const payload = await PUSH_CONFIG_BY_TYPE.EVIDENCE_SUBMITTED.buildPayload(row, ctx);

      expect(payload.body).toBe('Nova evidência esperando seu voto no Corrida matinal');
    });

    it('renders the aggregate variant citing the count when more than one posted today', async () => {
      const row = buildRow('EVIDENCE_SUBMITTED', 'evidence-1', FIXTURES.EVIDENCE_SUBMITTED.payload);
      const ctx = makeCtx(jest.fn().mockResolvedValue(3));

      const payload = await PUSH_CONFIG_BY_TYPE.EVIDENCE_SUBMITTED.buildPayload(row, ctx);

      expect(payload.body).toBe('3 pessoas postaram evidência hoje no Corrida matinal');
    });

    it('tags by (challenge, day) — contains the challengeId, never the evidence entityId', async () => {
      const row = buildRow('EVIDENCE_SUBMITTED', 'evidence-1', FIXTURES.EVIDENCE_SUBMITTED.payload);
      const ctx = makeCtx(jest.fn().mockResolvedValue(1));

      const payload = await PUSH_CONFIG_BY_TYPE.EVIDENCE_SUBMITTED.buildPayload(row, ctx);

      expect(payload.tag).toContain('challenge-1');
      expect(payload.tag).not.toContain('evidence-1');
    });

    it('degrades to the singular variant instead of throwing when the count query rejects', async () => {
      const row = buildRow('EVIDENCE_SUBMITTED', 'evidence-1', FIXTURES.EVIDENCE_SUBMITTED.payload);
      const ctx = makeCtx(jest.fn().mockRejectedValue(new Error('db unreachable')));

      const payload = await PUSH_CONFIG_BY_TYPE.EVIDENCE_SUBMITTED.buildPayload(row, ctx);

      expect(payload.body).toBe('Nova evidência esperando seu voto no Corrida matinal');
    });
  });

  describe('EVIDENCE_REMINDER', () => {
    it('throws — its payload is built by PushSenderService from the coalesced list, not a single row (D12-02)', async () => {
      const row = buildRow('EVIDENCE_REMINDER', 'participant-1:2026-08-01', {
        challengeTitle: 'Corrida matinal',
        challengeId: 'challenge-1',
      });

      expect(() =>
        PUSH_CONFIG_BY_TYPE.EVIDENCE_REMINDER.buildPayload(row, makeCtx(jest.fn())),
      ).toThrow(/PushSenderService/);
    });
  });
});
