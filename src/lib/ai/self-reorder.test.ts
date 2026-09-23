import { describe, it, expect } from 'vitest';
import type { ShopifyOrder } from '@/lib/shopify/types';
import { findSelfReorder, reorderMention } from './self-reorder';

let n = 0;
function order(o: {
  name: string;
  created: string;
  shipped?: string;
  total?: string;
  items: [title: string, variant: string][];
  tags?: string[];
  note?: string;
  cancelled?: string;
}): ShopifyOrder {
  n++;
  return {
    id: `gid://shopify/Order/${n}`,
    legacyResourceId: String(n),
    name: o.name,
    orderNumber: n,
    createdAt: o.created,
    updatedAt: o.created,
    financialStatus: 'PAID',
    fulfillmentStatus: o.shipped ? 'FULFILLED' : null,
    totalPrice: o.total ?? '39.82',
    totalPriceCurrency: 'USD',
    subtotalPrice: o.total ?? '39.82',
    totalShippingPrice: '0',
    totalTax: '0',
    lineItems: o.items.map(([title, variant], i) => ({
      id: `li-${n}-${i}`,
      title,
      variantTitle: variant,
      quantity: 1,
      originalUnitPrice: '34.95',
      originalUnitPriceCurrency: 'USD',
      selectedOptions: [
        { name: 'Color', value: variant.split(' / ')[0] },
        { name: 'Size', value: variant.split(' / ')[1] },
      ],
    })),
    fulfillments: o.shipped
      ? [{ id: `f-${n}`, status: 'SUCCESS', createdAt: o.shipped, updatedAt: o.shipped, lineItems: [] }]
      : [],
    tags: o.tags ?? [],
    note: o.note,
    customerId: 'c1',
    cancelledAt: o.cancelled,
  };
}

describe('reorderMention - what the customer says', () => {
  it('reads the real September messages the right way round', () => {
    // Kim had really reordered.
    expect(reorderMention('Also, I just placed another order for shirts and ordered the same shirt in a XL.')).toBe('done');
    // Toni and Lena had NOT - the old draft told both "you have already reordered".
    expect(reorderMention('I am reordering today hopefully the correct size. Thanks.')).toBe('planned');
    expect(reorderMention('These shirts are way to big. I will reorder, and then do the review.')).toBe('planned');
    expect(reorderMention('I have already placed an order for an alternate V-neck shirt!')).toBe('done');
    expect(reorderMention('rather than pay to return it I ordered a second tee in a large')).toBe('done');
  });

  it('ignores questions and wishes that are not a reorder', () => {
    expect(reorderMention('Do I need to reorder?')).toBeNull();
    expect(reorderMention('I would like to order another shirt for my sister')).toBeNull();
    expect(reorderMention('The shirt is too big, can I exchange it?')).toBeNull();
  });
});

describe('findSelfReorder - what Shopify shows', () => {
  it("finds Kim's own XL order and ignores our free replacement", () => {
    const original = order({ name: '#30536', created: '2026-07-20T10:00:00Z', shipped: '2026-07-24T10:00:00Z', items: [['All Berries Are Edible Some Only Once Premium', 'Seafoam / L']] });
    const reorder = order({ name: '#37604', created: '2026-09-05T17:57:10Z', total: '95.90', items: [['First of All I\'m a Delight Premium', 'Moss / XL'], ['All Berries Are Edible Some Only Once Premium', 'Seafoam / XL']] });
    const ours = order({ name: '#38156', created: '2026-09-09T08:41:39Z', total: '0.0', tags: ['Replacement', 'Size Exchange'], items: [['A Dilly of a Pickle Premium', 'Bay / XL']] });
    const r = findSelfReorder([ours, reorder, original], { originalOrderId: original.id });
    expect(r?.newOrder.name).toBe('#37604');
    expect(r?.originalOrder.name).toBe('#30536');
    expect(r?.sameDesign).toBe(true);
    expect(r?.newItem).toBe('All Berries Are Edible Some Only Once Premium - Seafoam / XL');
  });

  it('finds nothing for Toni and Lena, who only had our free replacements', () => {
    const toni = order({ name: '#37124', created: '2026-09-02T12:11:49Z', shipped: '2026-09-05T10:00:00Z', total: '66.68', items: [['I See A Puffin', 'Military Green / L']] });
    const cancelled = order({ name: '#38859', created: '2026-09-15T15:01:36Z', total: '0.0', cancelled: '2026-09-15T15:02:43Z', tags: ['Replacement'], items: [['I See A Puffin', 'Military Green / M']] });
    const free = order({ name: '#38860', created: '2026-09-15T15:01:39Z', total: '0.0', tags: ['Replacement'], items: [['I See A Puffin', 'Military Green / M']] });
    expect(findSelfReorder([free, cancelled, toni])).toBeNull();
  });

  it('does not count two sizes bought before the first one even shipped', () => {
    const a = order({ name: '#1', created: '2026-08-01T10:00:00Z', shipped: '2026-08-04T10:00:00Z', items: [['Frog Wizard Kerfuffle Premium', 'Mustard / M']] });
    const b = order({ name: '#2', created: '2026-08-01T18:00:00Z', shipped: '2026-08-04T10:00:00Z', items: [['Frog Wizard Kerfuffle Premium', 'Mustard / XL']] });
    expect(findSelfReorder([b, a], { originalOrderId: a.id })).toBeNull();
  });

  it('does not count the same design in the SAME size again (a double order, not a fix)', () => {
    const a = order({ name: '#1', created: '2026-08-01T10:00:00Z', shipped: '2026-08-04T10:00:00Z', items: [['Surrender Premium', 'Graphite / L']] });
    const b = order({ name: '#2', created: '2026-08-20T10:00:00Z', items: [['Surrender Premium', 'Graphite / L']] });
    expect(findSelfReorder([b, a], { originalOrderId: a.id })).toBeNull();
  });

  it('does not count a canceled order or one bought months later', () => {
    const a = order({ name: '#1', created: '2026-05-01T10:00:00Z', shipped: '2026-05-04T10:00:00Z', items: [['Surrender Premium', 'Graphite / L']] });
    const cancelled = order({ name: '#2', created: '2026-05-10T10:00:00Z', cancelled: '2026-05-10T11:00:00Z', items: [['Surrender Premium', 'Graphite / XL']] });
    const muchLater = order({ name: '#3', created: '2026-08-20T10:00:00Z', items: [['Surrender Premium', 'Graphite / XL']] });
    expect(findSelfReorder([muchLater, cancelled, a], { originalOrderId: a.id })).toBeNull();
  });

  it('uses the size they named to pick between several new orders, never to reject a clear one', () => {
    const a = order({ name: '#1', created: '2026-08-01T10:00:00Z', shipped: '2026-08-04T10:00:00Z', items: [['Surrender Premium', 'Graphite / L']] });
    const xl = order({ name: '#2', created: '2026-08-12T10:00:00Z', items: [['Surrender Premium', 'Graphite / XL']] });
    const xxl = order({ name: '#3', created: '2026-08-14T10:00:00Z', items: [['Surrender Premium', 'Graphite / 2XL']] });
    expect(findSelfReorder([xxl, xl, a], { originalOrderId: a.id, requestedSize: '2XL' })?.newOrder.name).toBe('#3');
    expect(findSelfReorder([xxl, xl, a], { originalOrderId: a.id })?.newOrder.name).toBe('#2');
    // Only an XL exists, and they asked for 2XL: still the same design in a new size.
    expect(findSelfReorder([xl, a], { originalOrderId: a.id, requestedSize: '2XL' })?.sameDesign).toBe(true);
  });

  it('reports a later order of a different design as a weaker match (Becky\'s v-neck)', () => {
    const a = order({ name: '#1', created: '2026-08-20T10:00:00Z', shipped: '2026-08-24T10:00:00Z', items: [['Off to Cause a Kerfuffle Premium', 'Mustard / S']] });
    const b = order({ name: '#2', created: '2026-09-06T10:00:00Z', items: [['Wait, I see a rock V-Neck Heather', 'Heather Dust / M']] });
    const r = findSelfReorder([b, a], { originalOrderId: a.id });
    expect(r?.sameDesign).toBe(false);
    expect(r?.newOrder.name).toBe('#2');
  });
});
