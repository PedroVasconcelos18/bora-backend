import { saoPauloDay, saoPauloEndOfDay } from './sao-paulo-day.util';

describe('sao-paulo-day.util', () => {
  describe('saoPauloDay', () => {
    it('resolves an instant to its America/Sao_Paulo calendar day (UTC-3)', () => {
      // 2026-07-19T02:30:00Z is 2026-07-18 23:30 in SP.
      expect(saoPauloDay(new Date('2026-07-19T02:30:00.000Z'))).toBe('2026-07-18');
    });
  });

  describe('saoPauloEndOfDay (item G)', () => {
    it('returns 23:59:59.999 SP as the correct UTC instant for a known day', () => {
      // 23:59:59.999 -03:00 on 2026-07-18 == 02:59:59.999Z on 2026-07-19.
      expect(saoPauloEndOfDay('2026-07-18').toISOString()).toBe('2026-07-19T02:59:59.999Z');
    });

    it('is the last SP instant that still maps back to the same SP day', () => {
      const close = saoPauloEndOfDay('2026-07-18');
      expect(saoPauloDay(close)).toBe('2026-07-18');
      // One millisecond later rolls into the next SP day.
      expect(saoPauloDay(new Date(close.getTime() + 1))).toBe('2026-07-19');
    });
  });
});
