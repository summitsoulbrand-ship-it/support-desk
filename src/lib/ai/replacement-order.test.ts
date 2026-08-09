import { describe, it, expect } from 'vitest';
import { replacementSignal, isReplacementOrder } from './replacement-order';
import type { ShopifyOrder } from '@/lib/shopify/types';

/**
 * A replacement and a purchase look identical in a list of orders, and drafts
 * were treating one as the other. Pati's own tell: a replacement is usually a
 * $0 order (2026-08-09).
 */
const order = (o: Partial<ShopifyOrder>): ShopifyOrder =>
  ({
    id: 'gid://shopify/Order/1',
    name: '#33603',
    totalPrice: '30.33',
    tags: [],
    lineItems: [{ title: 'Frog Wizard Kerfuffle', quantity: 1 }],
    ...o,
  }) as unknown as ShopifyOrder;

describe('replacementSignal', () => {
  it('catches the tag our own Replace button writes', () => {
    const s = replacementSignal(
      order({ tags: ['Replacement', 'Size Exchange'], totalPrice: '0.00' })
    );
    expect(s.isReplacement).toBe(true);
    expect(s.freeOfCharge).toBe(true);
  });

  it('reads which order it replaces out of the note', () => {
    const s = replacementSignal(
      order({ note: 'Replacement order for #32460 - Size exchange', totalPrice: '0.00' })
    );
    expect(s.isReplacement).toBe(true);
    expect(s.forOrder).toBe('#32460');
  });

  it('accepts looser hand-typed notes', () => {
    expect(replacementSignal(order({ note: 'reprint for 32460' })).forOrder).toBe('#32460');
    expect(replacementSignal(order({ note: 'replacement for #32460' })).forOrder).toBe(
      '#32460'
    );
  });

  it('catches a hand-made replacement with no tag and no note, by the $0 total', () => {
    const s = replacementSignal(order({ totalPrice: '0.00' }));
    expect(s.isReplacement).toBe(true);
    expect(s.freeOfCharge).toBe(true);
    expect(s.why).toContain('$0');
  });

  it('leaves a normal paid order alone', () => {
    expect(isReplacementOrder(order({ totalPrice: '30.33' }))).toBe(false);
  });

  it('does not call an empty $0 order a replacement', () => {
    // No line items - a cancelled or zeroed-out shell, not a shirt we sent.
    expect(isReplacementOrder(order({ totalPrice: '0.00', lineItems: [] }))).toBe(false);
  });
});
