import { describe, it, expect } from 'vitest';
import {
  canonicalSize,
  sizesEquivalent,
  stepSize,
  compareSizes,
  matchOrderForRequest,
  type MatchableOrder,
} from './order-match';

describe('size helpers', () => {
  it('canonicalizes size words and abbreviations', () => {
    expect(canonicalSize('Medium')).toBe('m');
    expect(canonicalSize('lg')).toBe('l');
    expect(canonicalSize('XXL')).toBe('2xl');
    expect(canonicalSize('not a size')).toBeNull();
  });

  it('treats equivalent sizes as equal regardless of spelling', () => {
    expect(sizesEquivalent('L', 'Large')).toBe(true);
    expect(sizesEquivalent('xl', 'X-Large')).toBe(true);
    expect(sizesEquivalent('M', 'L')).toBe(false);
    // unknown sizes fall back to case-insensitive string compare
    expect(sizesEquivalent('OneSize', 'onesize')).toBe(true);
  });

  it('steps one size up/down and stops at the ends', () => {
    expect(stepSize('M', 'up')).toBe('L');
    expect(stepSize('M', 'down')).toBe('S');
    expect(stepSize('XS', 'down')).toBeNull();
    expect(stepSize('5XL', 'up')).toBeNull();
    expect(stepSize('bogus', 'up')).toBeNull();
  });

  it('compares sizes ordinally', () => {
    expect(compareSizes('S', 'L')).toBe(-1);
    expect(compareSizes('XL', 'M')).toBe(1);
    expect(compareSizes('L', 'Large')).toBe(0);
    expect(compareSizes('?', 'L')).toBe(0); // unknown -> 0
  });
});

describe('matchOrderForRequest', () => {
  const order = (id: string, name: string, items: string[]): MatchableOrder => ({
    id,
    name,
    createdAt: '2026-06-01',
    lineItems: items.map((t) => ({ title: t })),
  });

  it('reports none when the customer has no orders', () => {
    const r = matchOrderForRequest([], { currentSize: 'M' });
    expect(r.confidence).toBe('none');
    expect(r.matchedOrderId).toBeNull();
    expect(r.ambiguous).toBe(false);
  });

  it('auto-picks the only order without needing any signal', () => {
    const r = matchOrderForRequest([order('o1', '#14386', ['Bison Tee M'])], {});
    expect(r.confidence).toBe('single');
    expect(r.matchedOrderId).toBe('o1');
    expect(r.ambiguous).toBe(false);
  });

  it('matches an explicitly named order number over everything else', () => {
    const orders = [order('o1', '#14386', ['Bison Tee M']), order('o2', '#15000', ['Rock Tee L'])];
    const r = matchOrderForRequest(orders, { orderNumber: '#15000', currentSize: 'M' });
    expect(r.confidence).toBe('explicit');
    expect(r.matchedOrderId).toBe('o2');
  });

  it('infers the order from a unique size signal', () => {
    const orders = [order('o1', '#1', ['Bison Tee Medium']), order('o2', '#2', ['Rock Tee Large'])];
    const r = matchOrderForRequest(orders, { currentSize: 'L' });
    expect(r.confidence).toBe('inferred');
    expect(r.matchedOrderId).toBe('o2');
    expect(r.ambiguous).toBe(false);
  });

  it('infers the order from a unique product hint', () => {
    const orders = [order('o1', '#1', ['Bison Tee M']), order('o2', '#2', ['Wanderlust Rocks Tee M'])];
    const r = matchOrderForRequest(orders, { lineItemHint: 'wanderlust' });
    expect(r.confidence).toBe('inferred');
    expect(r.matchedOrderId).toBe('o2');
  });

  it('is ambiguous when multiple orders tie with no distinguishing signal', () => {
    const orders = [order('o1', '#1', ['Bison Tee M']), order('o2', '#2', ['Rock Tee M'])];
    const r = matchOrderForRequest(orders, { currentSize: 'M' });
    expect(r.confidence).toBe('ambiguous');
    expect(r.matchedOrderId).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it('does not let a lone "s" size token match arbitrary words', () => {
    // "Bigfoot Crew" contains no standalone size; an S request must not match it
    const orders = [order('o1', '#1', ['Bigfoot Crew']), order('o2', '#2', ['Trail Tee Small'])];
    const r = matchOrderForRequest(orders, { currentSize: 'S' });
    expect(r.matchedOrderId).toBe('o2');
    expect(r.confidence).toBe('inferred');
  });
});
