import { describe, it, expect } from 'vitest';
import {
  buildMergedLines,
  desiredSkuQuantities,
  diffSkus,
  isUpsellTagged,
  printifySkuQuantities,
} from './upsell-merge';
import type { PrintifyOrder } from './types';
import type { ShopifyOrder } from '@/lib/shopify/types';

function shopifyOrder(
  lines: { sku?: string; quantity: number; title?: string }[],
  tags: string[] = ['Kaching Upsell']
): ShopifyOrder {
  return {
    id: 'gid://shopify/Order/1',
    legacyResourceId: '1',
    name: '#37340',
    orderNumber: 37340,
    createdAt: '2026-09-03T00:00:00Z',
    updatedAt: '2026-09-03T00:00:00Z',
    financialStatus: 'PAID',
    fulfillmentStatus: null,
    totalPrice: '44.00',
    totalPriceCurrency: 'USD',
    subtotalPrice: '44.00',
    totalShippingPrice: '0.00',
    totalTax: '0.00',
    lineItems: lines.map((l, i) => ({
      id: `gid://shopify/LineItem/${i}`,
      title: l.title || 'Tee',
      quantity: l.quantity,
      originalUnitPrice: '22.00',
      originalUnitPriceCurrency: 'USD',
      sku: l.sku,
    })),
    fulfillments: [],
    tags,
    customerId: 'gid://shopify/Customer/1',
  };
}

function printifyOrder(
  lines: { sku?: string; quantity: number; product_id?: string; variant_id?: number }[],
  id = 'p1'
): PrintifyOrder {
  return {
    id,
    status: 'on-hold',
    created_at: '2026-09-03T00:00:00Z',
    address_to: {} as PrintifyOrder['address_to'],
    line_items: lines.map((l, i) => ({
      product_id: l.product_id || `prod-${i}`,
      variant_id: l.variant_id ?? 100 + i,
      quantity: l.quantity,
      cost: 0,
      shipping: 0,
      status: 'on-hold',
      metadata: { sku: l.sku },
    })) as PrintifyOrder['line_items'],
    shipments: [],
    total_price: 0,
    total_shipping: 0,
    total_tax: 0,
  };
}

describe('isUpsellTagged', () => {
  it('matches the configured tag case-insensitively', () => {
    expect(isUpsellTagged(['Kaching Upsell'], 'kaching')).toBe(true);
    expect(isUpsellTagged(['kaching upsell'], 'Kaching Upsell')).toBe(true);
  });

  it('does not match an untagged order', () => {
    expect(isUpsellTagged(['gift', 'vip'], 'kaching')).toBe(false);
  });

  // The gate is the whole safety story: an empty tag must match NOTHING, or a
  // missing env var would turn every order into a rebuild candidate.
  it('matches nothing when no tag is configured', () => {
    expect(isUpsellTagged(['Kaching Upsell'], '')).toBe(false);
    expect(isUpsellTagged([], '')).toBe(false);
  });
});

describe('sku quantity maps', () => {
  it('aggregates repeated skus on both sides', () => {
    expect(
      desiredSkuQuantities(shopifyOrder([{ sku: 'A', quantity: 1 }, { sku: 'A', quantity: 2 }]))
    ).toEqual({ A: 3 });
    expect(
      printifySkuQuantities(printifyOrder([{ sku: 'A', quantity: 1 }, { sku: 'A', quantity: 2 }]))
    ).toEqual({ A: 3 });
  });

  it('ignores lines Shopify has already zeroed out by edit or refund', () => {
    expect(desiredSkuQuantities(shopifyOrder([{ sku: 'A', quantity: 0 }]))).toEqual({});
  });
});

describe('diffSkus', () => {
  it('finds an upsold item that Printify never received', () => {
    const d = diffSkus(
      shopifyOrder([{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }]),
      [printifyOrder([{ sku: 'A', quantity: 1 }])]
    );
    expect(d.missing).toEqual({ B: 1 });
    expect(d.extra).toEqual({});
  });

  // A count compare would call this "already complete" - the exact miss the
  // per-SKU quantity diff exists to catch.
  it('finds an upsell that only bumps the quantity of an existing sku', () => {
    const d = diffSkus(
      shopifyOrder([{ sku: 'A', quantity: 2 }]),
      [printifyOrder([{ sku: 'A', quantity: 1 }])]
    );
    expect(d.missing).toEqual({ A: 1 });
  });

  it('reports nothing missing when the two sides already agree', () => {
    const d = diffSkus(
      shopifyOrder([{ sku: 'A', quantity: 1 }]),
      [printifyOrder([{ sku: 'A', quantity: 1 }])]
    );
    expect(d.missing).toEqual({});
    expect(d.extra).toEqual({});
  });

  it('flags a refunded line as extra, not missing', () => {
    const d = diffSkus(
      shopifyOrder([{ sku: 'A', quantity: 1 }]),
      [printifyOrder([{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }])]
    );
    expect(d.missing).toEqual({});
    expect(d.extra).toEqual({ B: 1 });
  });

  it('refuses to trust the diff when a Printify line has no sku', () => {
    const d = diffSkus(
      shopifyOrder([{ sku: 'A', quantity: 1 }]),
      [printifyOrder([{ quantity: 1 }])]
    );
    expect(d.skusKnown).toBe(false);
  });
});

describe('buildMergedLines', () => {
  it('copies existing lines by product+variant and adds the upsell by sku', () => {
    const po = printifyOrder([
      { sku: 'A', quantity: 1, product_id: 'prodA', variant_id: 11 },
    ]);
    const order = shopifyOrder([{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }]);
    const lines = buildMergedLines([po], diffSkus(order, [po]));

    // The line Printify already holds must never be re-resolved - that is how a
    // rebuild lands on the wrong design.
    expect(lines).toContainEqual({ product_id: 'prodA', variant_id: 11, quantity: 1 });
    expect(lines).toContainEqual({ sku: 'B', quantity: 1 });
    expect(lines).toHaveLength(2);
  });

  it('keeps the original quantity and adds only the extra unit', () => {
    const po = printifyOrder([
      { sku: 'A', quantity: 1, product_id: 'prodA', variant_id: 11 },
    ]);
    const order = shopifyOrder([{ sku: 'A', quantity: 3 }]);
    const lines = buildMergedLines([po], diffSkus(order, [po]));
    const total = lines.reduce((n, l) => n + l.quantity, 0);
    expect(total).toBe(3);
  });

  it('drops a refunded line instead of reprinting it', () => {
    const po = printifyOrder([
      { sku: 'A', quantity: 1, product_id: 'prodA', variant_id: 11 },
      { sku: 'B', quantity: 1, product_id: 'prodB', variant_id: 22 },
    ]);
    const order = shopifyOrder([{ sku: 'A', quantity: 1 }, { sku: 'C', quantity: 1 }]);
    const lines = buildMergedLines([po], diffSkus(order, [po]));

    expect(lines).toContainEqual({ product_id: 'prodA', variant_id: 11, quantity: 1 });
    expect(lines).toContainEqual({ sku: 'C', quantity: 1 });
    expect(lines.some((l) => l.product_id === 'prodB')).toBe(false);
  });

  it('reduces a partially refunded line rather than dropping it whole', () => {
    const po = printifyOrder([
      { sku: 'A', quantity: 3, product_id: 'prodA', variant_id: 11 },
    ]);
    const order = shopifyOrder([{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }]);
    const lines = buildMergedLines([po], diffSkus(order, [po]));

    expect(lines).toContainEqual({ product_id: 'prodA', variant_id: 11, quantity: 1 });
    expect(lines).toContainEqual({ sku: 'B', quantity: 1 });
  });
});

// The case Pati raised: the upsell may arrive as its OWN second Printify order
// rather than being ignored. Then nothing is "missing" - but the customer would
// get two boxes and two tracking numbers for one order, so the two still have
// to become one.
describe('upsell split across two Printify orders', () => {
  const first = printifyOrder(
    [{ sku: 'A', quantity: 1, product_id: 'prodA', variant_id: 11 }],
    'p1'
  );
  const second = printifyOrder(
    [{ sku: 'B', quantity: 1, product_id: 'prodB', variant_id: 22 }],
    'p2'
  );
  const order = shopifyOrder([{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }]);

  it('sees the two copies as complete between them', () => {
    const d = diffSkus(order, [first, second]);
    expect(d.missing).toEqual({});
    expect(d.extra).toEqual({});
  });

  it('builds ONE order carrying every line from both', () => {
    const lines = buildMergedLines([first, second], diffSkus(order, [first, second]));
    expect(lines).toContainEqual({ product_id: 'prodA', variant_id: 11, quantity: 1 });
    expect(lines).toContainEqual({ product_id: 'prodB', variant_id: 22, quantity: 1 });
    expect(lines).toHaveLength(2);
  });

  it('still adds an item neither copy received', () => {
    const withThird = shopifyOrder([
      { sku: 'A', quantity: 1 },
      { sku: 'B', quantity: 1 },
      { sku: 'C', quantity: 1 },
    ]);
    const d = diffSkus(withThird, [first, second]);
    expect(d.missing).toEqual({ C: 1 });
    const lines = buildMergedLines([first, second], d);
    expect(lines).toContainEqual({ sku: 'C', quantity: 1 });
    expect(lines).toHaveLength(3);
  });
});

// The #27253 scar: a multi-item change resolved by VARIANT LABEL landed on the
// wrong design, and a Wanderlust M printed as a second Owl. Every tee on this
// store shares the same size/colour matrix, so a label matches every product.
// These tests pin the two properties that make that impossible here.
describe('cannot repeat the wrong-design bug (#27253)', () => {
  const owl = printifyOrder(
    [{ sku: 'OWL-M', quantity: 1, product_id: 'prodOwl', variant_id: 11 }],
    'p1'
  );

  it('never asks Printify to resolve an existing line by label', () => {
    const order = shopifyOrder([
      { sku: 'OWL-M', quantity: 1, title: 'Owl' },
      { sku: 'WANDER-M', quantity: 1, title: 'Wanderlust' },
    ]);
    const lines = buildMergedLines([owl], diffSkus(order, [owl]));

    // No line may carry a variant label - that is the field whose fuzzy
    // matching caused the wrong design to print.
    for (const l of lines) {
      expect(l).not.toHaveProperty('variantLabel');
      expect(l).not.toHaveProperty('itemTitle');
      // Every line is pinned either by Printify's own ids or by a unique SKU.
      expect(Boolean(l.sku) || Boolean(l.product_id && l.variant_id)).toBe(true);
    }
  });

  it('keeps an existing line pinned to its own product and variant', () => {
    const order = shopifyOrder([
      { sku: 'OWL-M', quantity: 1, title: 'Owl' },
      { sku: 'WANDER-M', quantity: 1, title: 'Wanderlust' },
    ]);
    const lines = buildMergedLines([owl], diffSkus(order, [owl]));
    const kept = lines.find((l) => l.product_id === 'prodOwl');
    expect(kept).toEqual({ product_id: 'prodOwl', variant_id: 11, quantity: 1 });
    // The added design goes in by its own SKU, never by borrowing the Owl's ids.
    expect(lines).toContainEqual({ sku: 'WANDER-M', quantity: 1 });
  });

  it('folds a quantity bump into the existing line, not a duplicate line', () => {
    const order = shopifyOrder([{ sku: 'OWL-M', quantity: 3, title: 'Owl' }]);
    const lines = buildMergedLines([owl], diffSkus(order, [owl]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ product_id: 'prodOwl', variant_id: 11, quantity: 3 });
  });
});

// Pati's decision: an upsell that arrives after the original is already
// printing must ship as a SECOND box, not be quietly dropped. These pin the
// line maths that feeds that path.
describe('too late to merge: what the second box carries', () => {
  const printing = printifyOrder(
    [{ sku: 'A', quantity: 1, product_id: 'prodA', variant_id: 11 }],
    'p1'
  );

  it('carries ONLY the items the printing order is missing', () => {
    const order = shopifyOrder([{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }]);
    const d = diffSkus(order, [printing]);
    // The add-on is built from diff.missing alone - never from the whole order,
    // which would reprint the shirt already in production.
    expect(d.missing).toEqual({ B: 1 });
    expect(Object.keys(d.missing)).not.toContain('A');
  });

  it('carries only the extra unit when the upsell is the same shirt again', () => {
    const order = shopifyOrder([{ sku: 'A', quantity: 2 }]);
    expect(diffSkus(order, [printing]).missing).toEqual({ A: 1 });
  });

  // Once the add-on exists it is a live copy too, so the next pass sees both and
  // must conclude nothing is missing - otherwise it would print a third box
  // every two minutes.
  it('sees nothing missing once the add-on exists alongside the printing order', () => {
    const addOn = printifyOrder(
      [{ sku: 'B', quantity: 1, product_id: 'prodB', variant_id: 22 }],
      'p2'
    );
    const order = shopifyOrder([{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }]);
    const d = diffSkus(order, [printing, addOn]);
    expect(d.missing).toEqual({});
    expect(d.extra).toEqual({});
  });
});
