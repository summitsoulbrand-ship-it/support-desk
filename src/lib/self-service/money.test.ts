/**
 * The swap money math. Every case here is customer money - keep green.
 * Scenario space: no discount, percentage code, cheaper/pricier/same swaps.
 */

import { describe, it, expect } from 'vitest';
import { computeSwapMoney } from './money';

const line = (full: number, paid: number, quantity = 1) => ({ full, paid, quantity });

describe('computeSwapMoney', () => {
  it('same price, no discount: nothing moves, no absorb', () => {
    const l = line(29.95, 29.95);
    const m = computeSwapMoney([l], l, 29.95);
    expect(m.kind).toBe('same');
    expect(m.amount).toBe(0);
    expect(m.absorb).toBe(0);
  });

  it('pricier, no discount: charge the full difference (M -> L, 29.95 -> 31.95)', () => {
    const l = line(29.95, 29.95);
    const m = computeSwapMoney([l], l, 31.95);
    expect(m.kind).toBe('charge');
    expect(m.amount).toBe(2.0);
    // No code: added line at full price, no absorb needed - balance = 2.00.
    expect(m.absorb).toBe(0);
  });

  it('cheaper, no discount: refund the difference (L -> M)', () => {
    const l = line(31.95, 31.95);
    const m = computeSwapMoney([l], l, 29.95);
    expect(m.kind).toBe('refund');
    expect(m.amount).toBe(2.0);
    expect(m.absorb).toBe(0);
  });

  it('pricier with a 15% code: customer pays the DISCOUNTED difference', () => {
    // $29.95 tee bought with 15% off -> paid 25.46
    const l = line(29.95, 25.46);
    const m = computeSwapMoney([l], l, 31.95);
    expect(m.kind).toBe('charge');
    // 2.00 * 0.85 = 1.70
    expect(m.amount).toBeCloseTo(1.7, 2);
    // Shopify re-applies the 15% over the added 31.95 line -> nets 27.16,
    // which is exactly removedPaid + 1.70 = 27.16. No absorb needed.
    expect(m.absorb).toBeCloseTo(0, 2);
  });

  it('same price with a 15% code: absorb stays 0, nothing moves', () => {
    const l = line(29.95, 25.46);
    const m = computeSwapMoney([l], l, 29.95);
    expect(m.kind).toBe('same');
    expect(m.amount).toBe(0);
    expect(m.absorb).toBeCloseTo(0, 2);
  });

  it('cheaper with a 15% code: refund the discounted difference', () => {
    const l = line(31.95, 27.16);
    const m = computeSwapMoney([l], l, 29.95);
    expect(m.kind).toBe('refund');
    expect(m.amount).toBeCloseTo(1.7, 2);
  });

  it('multi-line order: rate derives from the whole order, swap touches one line', () => {
    const a = line(29.95, 25.46); // 15% off
    const b = line(33.95, 28.86, 2); // 15% off, qty 2
    const m = computeSwapMoney([a, b], a, 31.95);
    expect(m.kind).toBe('charge');
    expect(m.amount).toBeCloseTo(1.7, 2);
  });

  it('quantity > 1: difference scales with quantity', () => {
    const l = line(29.95, 29.95, 2);
    const m = computeSwapMoney([l], l, 31.95);
    expect(m.kind).toBe('charge');
    expect(m.amount).toBe(4.0);
  });

  it('absorb never goes negative', () => {
    const l = line(29.95, 29.95);
    const m = computeSwapMoney([l], l, 25.95);
    expect(m.absorb).toBeGreaterThanOrEqual(0);
  });
});
