import { describe, it, expect } from 'vitest';
import {
  replacementSignal,
  isReplacementOrder,
  reprintAsExistingReplacement,
} from './replacement-order';
import type { ReprintSummary } from '@/lib/printify/reprint';
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

describe('reprintAsExistingReplacement', () => {
  const base: ReprintSummary = {
    printifyOrderId: 'abc',
    appOrderId: '19269685.39876',
    forOrderName: '#37037',
    createdAt: '2026-09-18T05:20:12.000Z',
    stage: 'shipped',
    items: ['Surrender Premium - Graphite / L'],
    tracking: {
      carrier: 'DHL',
      number: '9261290223382099960691',
      url: 'https://easyordertracking.aftership.com/9261290223382099960691',
      shippedAt: '2026-09-19T18:00:00.000Z',
      deliveredAt: null,
    },
  };

  it('files a Printify reprint under the order it replaces, with its tracking', () => {
    const r = reprintAsExistingReplacement(base);
    expect(r.forOrder).toBe('#37037');
    expect(r.fulfillmentStatus).toBe('SHIPPED on 2026-09-19 - on its way to the customer');
    expect(r.tracking).toBe(
      'DHL 9261290223382099960691 (https://easyordertracking.aftership.com/9261290223382099960691)'
    );
    expect(r.freeOfCharge).toBe(true);
  });

  it('keeps the Printify number out of what the customer may be told', () => {
    const r = reprintAsExistingReplacement(base);
    expect(r.replacementOrder).not.toContain('19269685');
    expect(r.howWeKnow).toContain('never give it to the customer');
  });

  it('says plainly when the reprint has not even gone to print', () => {
    const r = reprintAsExistingReplacement({ ...base, stage: 'waiting', tracking: null });
    expect(r.fulfillmentStatus).toMatch(/NOT PRINTING YET/);
    expect(r.tracking).toBeUndefined();
  });
});
