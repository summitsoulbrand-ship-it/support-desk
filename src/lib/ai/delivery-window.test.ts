import { describe, it, expect } from 'vitest';
import { addBusinessDays, estimateArrivalWindow } from './delivery-window';

describe('addBusinessDays', () => {
  it('skips weekends', () => {
    // Fri 2026-06-26 + 1 business day = Mon 2026-06-29
    const fri = new Date('2026-06-26T12:00:00');
    expect(addBusinessDays(fri, 1).getDay()).toBe(1); // Monday
  });
});

describe('estimateArrivalWindow', () => {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date('2026-06-25T12:00:00'); // Thursday

  it('NOT shipped: assumes full production (4d): earliest = order+6 bd, latest = order+9 bd', () => {
    const created = '2026-06-25T09:00:00';
    const w = estimateArrivalWindow(created, false, now);
    expect(day(w.earliest)).toBe(day(addBusinessDays(new Date(created), 6)));
    expect(day(w.latest)).toBe(day(addBusinessDays(new Date(created), 9)));
  });

  it('shipped (no carrier ETA): uses 1 production day: earliest = order+3 bd, latest = order+6 bd', () => {
    const created = '2026-06-25T09:00:00';
    const w = estimateArrivalWindow(created, true, now);
    expect(day(w.earliest)).toBe(day(addBusinessDays(new Date(created), 3)));
    expect(day(w.latest)).toBe(day(addBusinessDays(new Date(created), 6)));
  });

  it('never returns a past earliest for an OLD unshipped order (the bug)', () => {
    const w = estimateArrivalWindow('2026-06-15T09:00:00', false, now);
    expect(w.earliest.getTime()).toBeGreaterThanOrEqual(now.getTime());
    expect(day(w.earliest)).toBe(day(addBusinessDays(now, 2)));
  });

  it('floors earliest to today + 2 business days and latest to today + 5 for a very old order', () => {
    const w = estimateArrivalWindow('2026-05-01T09:00:00', false, now);
    expect(day(w.earliest)).toBe(day(addBusinessDays(now, 2)));
    expect(day(w.latest)).toBe(day(addBusinessDays(now, 5)));
  });
});
