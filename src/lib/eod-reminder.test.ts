import { describe, it, expect } from 'vitest';
import { msUntilNextManilaHour, startOfManilaDay } from './eod-reminder';

/** A UTC instant written as the Manila wall clock it corresponds to. */
function atManila(y: number, m: number, d: number, h: number, min = 0): Date {
  return new Date(Date.UTC(y, m - 1, d, h, min) - 8 * 60 * 60 * 1000);
}

const HOUR = 60 * 60 * 1000;

describe('startOfManilaDay', () => {
  it('is midnight Manila, not midnight UTC', () => {
    // 07:00 Manila on the 28th is still the 27th in UTC - the day must not
    // roll over with UTC, or her whole morning lands on the wrong report.
    expect(startOfManilaDay(atManila(2026, 7, 28, 7)).toISOString()).toBe(
      '2026-07-27T16:00:00.000Z'
    );
  });

  it('holds across the UTC midnight crossing', () => {
    const before = startOfManilaDay(atManila(2026, 7, 28, 7));
    const after = startOfManilaDay(atManila(2026, 7, 28, 9));
    expect(after.getTime()).toBe(before.getTime());
  });
});

describe('msUntilNextManilaHour', () => {
  it('waits until later the same day', () => {
    expect(msUntilNextManilaHour(18, atManila(2026, 7, 28, 6))).toBe(12 * HOUR);
  });

  it('rolls to tomorrow once the hour has passed', () => {
    expect(msUntilNextManilaHour(18, atManila(2026, 7, 28, 19))).toBe(23 * HOUR);
  });

  it('waits a full day when it is exactly the hour, never zero', () => {
    // A zero-length wait would fire the timer in a tight loop.
    expect(msUntilNextManilaHour(18, atManila(2026, 7, 28, 18))).toBe(24 * HOUR);
  });

  it('is always strictly positive across every minute of the day', () => {
    for (let h = 0; h < 24; h++) {
      for (const min of [0, 1, 30, 59]) {
        const ms = msUntilNextManilaHour(18, atManila(2026, 7, 28, h, min));
        expect(ms).toBeGreaterThan(0);
        expect(ms).toBeLessThanOrEqual(24 * HOUR);
      }
    }
  });
});
