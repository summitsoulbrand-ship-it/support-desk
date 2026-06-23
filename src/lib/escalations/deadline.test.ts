import { describe, it, expect } from 'vitest';
import { claimWindowFromDelivery, latestDeliveredAt, PRINTIFY_CLAIM_WINDOW_DAYS } from './deadline';

const NOW = new Date('2026-06-22T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000).toISOString();

describe('claimWindowFromDelivery', () => {
  it('returns unknown when there is no delivery date', () => {
    expect(claimWindowFromDelivery(null, NOW).status).toBe('unknown');
    expect(claimWindowFromDelivery(undefined, NOW).daysLeft).toBeNull();
    expect(claimWindowFromDelivery('not-a-date', NOW).status).toBe('unknown');
  });

  it('is ok with plenty of runway', () => {
    const w = claimWindowFromDelivery(daysAgo(5), NOW); // 25 days left
    expect(w.status).toBe('ok');
    expect(w.daysLeft).toBe(PRINTIFY_CLAIM_WINDOW_DAYS - 5);
  });

  it('flags soon within the threshold', () => {
    const w = claimWindowFromDelivery(daysAgo(27), NOW); // 3 days left
    expect(w.status).toBe('soon');
    expect(w.daysLeft).toBe(3);
  });

  it('flags overdue past the window with a negative daysLeft', () => {
    const w = claimWindowFromDelivery(daysAgo(40), NOW); // 10 days over
    expect(w.status).toBe('overdue');
    expect(w.daysLeft).toBeLessThan(0);
  });

  it('respects a custom soon threshold', () => {
    expect(claimWindowFromDelivery(daysAgo(22), NOW, 10).status).toBe('soon'); // 8 days left
    expect(claimWindowFromDelivery(daysAgo(22), NOW, 5).status).toBe('ok');
  });

  it('puts the deadline exactly 30 days after delivery', () => {
    const w = claimWindowFromDelivery('2026-06-01T00:00:00Z', NOW);
    expect(w.deadline).toBe('2026-07-01T00:00:00.000Z');
  });
});

describe('latestDeliveredAt', () => {
  it('returns null when no shipment has delivered', () => {
    expect(latestDeliveredAt(null)).toBeNull();
    expect(latestDeliveredAt([])).toBeNull();
    expect(latestDeliveredAt([{ delivered_at: null }])).toBeNull();
  });

  it('picks the most recent delivery across shipments', () => {
    const r = latestDeliveredAt([
      { delivered_at: '2026-06-01T00:00:00Z' },
      { delivered_at: '2026-06-10T00:00:00Z' },
      { delivered_at: null },
    ]);
    expect(r).toBe('2026-06-10T00:00:00.000Z');
  });
});
