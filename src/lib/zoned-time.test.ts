import { describe, it, expect } from 'vitest';
import { msUntilNextZonedHour, zonedParts } from './zoned-time';

const ET = 'America/New_York';
const HOUR = 60 * 60 * 1000;

describe('msUntilNextZonedHour', () => {
  it('waits until later the same day when the hour is still ahead', () => {
    // 2026-09-04 18:00 UTC = 14:00 EDT. Next 20:00 EDT is 6 hours away.
    const now = new Date('2026-09-04T18:00:00Z');
    expect(msUntilNextZonedHour(20, ET, now)).toBe(6 * HOUR);
  });

  it('rolls to tomorrow once the hour has passed', () => {
    // 2026-09-05 01:00 UTC = 2026-09-04 21:00 EDT, just past 20:00.
    const now = new Date('2026-09-05T01:00:00Z');
    expect(msUntilNextZonedHour(20, ET, now)).toBe(23 * HOUR);
  });

  it('returns a full day, never zero, when called exactly on the hour', () => {
    // 2026-09-05 00:00 UTC = 2026-09-04 20:00 EDT exactly.
    const now = new Date('2026-09-05T00:00:00Z');
    expect(msUntilNextZonedHour(20, ET, now)).toBe(24 * HOUR);
  });

  it('still lands on 20:00 local across the autumn DST change', () => {
    // 2026-11-01 is the US fall-back day; the evening runs on EST (UTC-5).
    const now = new Date('2026-11-01T12:00:00Z');
    const fire = new Date(now.getTime() + msUntilNextZonedHour(20, ET, now));
    expect(zonedParts(fire, ET).hour).toBe(20);
    expect(fire.toISOString()).toBe('2026-11-02T01:00:00.000Z');
  });

  it('still lands on 20:00 local across the spring DST change', () => {
    // 2026-03-08 is the US spring-forward day; the evening runs on EDT (UTC-4).
    const now = new Date('2026-03-08T12:00:00Z');
    const fire = new Date(now.getTime() + msUntilNextZonedHour(20, ET, now));
    expect(zonedParts(fire, ET).hour).toBe(20);
    expect(fire.toISOString()).toBe('2026-03-09T00:00:00.000Z');
  });
});
