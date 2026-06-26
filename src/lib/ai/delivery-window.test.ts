import { describe, it, expect } from 'vitest';
import { addBusinessDays, unshippedDeliveryWindow } from './delivery-window';

describe('addBusinessDays', () => {
  it('skips weekends', () => {
    // Fri 2026-06-26 + 1 business day = Mon 2026-06-29
    const fri = new Date('2026-06-26T12:00:00');
    expect(addBusinessDays(fri, 1).getDay()).toBe(1); // Monday
  });
});

describe('unshippedDeliveryWindow', () => {
  const day = (d: Date) => d.toISOString().slice(0, 10);

  it('uses the order-date window for a fresh order', () => {
    // Order placed today; window should be created+3 .. created+9 business days
    const now = new Date('2026-06-25T12:00:00'); // Thursday
    const w = unshippedDeliveryWindow('2026-06-25T09:00:00', now);
    expect(w.earliest.getTime()).toBeGreaterThan(now.getTime());
    expect(w.latest.getTime()).toBeGreaterThan(w.earliest.getTime());
  });

  it('never returns a past earliest for an OLD unshipped order (the bug)', () => {
    // Order placed 10 days ago; naive created+3 would be in the past
    const now = new Date('2026-06-25T12:00:00');
    const w = unshippedDeliveryWindow('2026-06-15T09:00:00', now);
    expect(w.earliest.getTime()).toBeGreaterThanOrEqual(now.getTime());
    // earliest is floored to now + 2 business days
    expect(day(w.earliest)).toBe(day(addBusinessDays(now, 2)));
  });

  it('floors earliest to today + 2 business days and latest to today + 5', () => {
    const now = new Date('2026-06-25T12:00:00');
    const w = unshippedDeliveryWindow('2026-05-01T09:00:00', now); // very old
    expect(day(w.earliest)).toBe(day(addBusinessDays(now, 2)));
    expect(day(w.latest)).toBe(day(addBusinessDays(now, 5)));
  });
});
