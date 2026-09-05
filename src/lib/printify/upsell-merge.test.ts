import { describe, it, expect } from 'vitest';
import {
  buildMergedLines,
  inPrintifyBlackout,
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

// The 2026-09-05 incident, in one test. A Printify order created through the
// API carries Printify's OWN product ids and skus, not the Shopify ones. So a
// second look at an order we had already rebuilt saw every Shopify sku as
// missing and every Printify sku as extra - and shipped a duplicate.
describe('a rebuilt order is not keyed like the Shopify order', () => {
  const rebuiltByApi = printifyOrder(
    [
      { sku: '73219889441875170278', quantity: 1, product_id: 'pfProdA', variant_id: 78963 },
      { sku: '53524441268337865391', quantity: 1, product_id: 'pfProdB', variant_id: 78892 },
    ],
    'p-rebuilt'
  );
  const order = shopifyOrder([
    { sku: '45734061661932517590', quantity: 1 },
    { sku: '76857322688795117598', quantity: 1 },
  ]);

  it('reads as a total mismatch, not as missing items', () => {
    const d = diffSkus(order, [rebuiltByApi]);
    // Both sides full. Taken at face value this says "print the whole order
    // again", which is exactly what happened to #37449 and #37484.
    expect(Object.keys(d.missing)).toHaveLength(2);
    expect(Object.keys(d.extra)).toHaveLength(2);
  });

  it('shares no SKU with Shopify, and has the SAME unit count', () => {
    const d = diffSkus(order, [rebuiltByApi]);
    // Overlap zero + equal totals is the signature of our own rebuild. It is
    // complete, so the right answer is silence, not a duplicate and not an alarm.
    expect(d.overlap).toBe(0);
    expect(d.wantUnits).toBe(d.haveUnits);
  });

  // The guard must NOT catch this: #37497 on 2026-09-05, where the customer
  // swapped a Surrender colourway. Missing AND extra, entirely legitimate, and
  // the merge handled it correctly - so "missing and extra" is the wrong test.
  it('does not look like a colour swap, which still shares its other SKUs', () => {
    const printify = printifyOrder(
      [
        { sku: '18807753494422715805', quantity: 1, product_id: 'pA', variant_id: 1 },
        { sku: '10589115953513130357', quantity: 1, product_id: 'pB', variant_id: 2 },
      ],
      'p-swap'
    );
    const swapped = shopifyOrder([
      { sku: '18807753494422715805', quantity: 1 },
      { sku: '25235664872568011282', quantity: 1 },
    ]);
    const d = diffSkus(swapped, [printify]);
    expect(Object.keys(d.missing)).toHaveLength(1);
    expect(Object.keys(d.extra)).toHaveLength(1);
    expect(d.overlap).toBe(1); // shares the unchanged shirt - so it IS actionable
  });

  it('is distinguishable from a genuine upsell, which has NO extra', () => {
    const genuine = printifyOrder(
      [{ sku: '45734061661932517590', quantity: 1, product_id: 'prodA', variant_id: 11 }],
      'p-original'
    );
    const d = diffSkus(order, [genuine]);
    expect(d.missing).toEqual({ '76857322688795117598': 1 });
    expect(d.extra).toEqual({});
  });
});

// 07:05 on 2026-09-05 is the exact minute the merge ran and could cancel
// nothing, because Printify's nightly print run was under way.
describe('Printify blackout window', () => {
  const at = (h: number, m: number) => new Date(Date.UTC(2026, 8, 5, h, m));

  it('is closed during the print run', () => {
    expect(inPrintifyBlackout(at(7, 5))).toBe(true);
    expect(inPrintifyBlackout(at(6, 55))).toBe(true);
    expect(inPrintifyBlackout(at(7, 29))).toBe(true);
  });

  it('is also closed while the order combiner is running', () => {
    expect(inPrintifyBlackout(at(5, 0))).toBe(true);
    expect(inPrintifyBlackout(at(5, 19))).toBe(true);
  });

  it('is open the rest of the day', () => {
    expect(inPrintifyBlackout(at(6, 49))).toBe(false);
    expect(inPrintifyBlackout(at(5, 20))).toBe(false);
    expect(inPrintifyBlackout(at(4, 54))).toBe(false);
    expect(inPrintifyBlackout(at(7, 30))).toBe(false);
    expect(inPrintifyBlackout(at(18, 51))).toBe(false); // when the good merges ran
    expect(inPrintifyBlackout(at(0, 0))).toBe(false);
  });
});

// The record-based comparison, in the terms it actually runs on. Once we have
// written down what an order was built from, Printify's private labels stop
// mattering: the question becomes "what has appeared on Shopify SINCE".
describe('comparing against our own record of the build', () => {
  const since = (built: Record<string, number>, wanted: Record<string, number>) => {
    const out: Record<string, number> = {};
    for (const [sku, qty] of Object.entries(wanted)) {
      const delta = qty - (built[sku] || 0);
      if (delta > 0) out[sku] = delta;
    }
    return out;
  };

  it('sees nothing new when the order has not changed since we built it', () => {
    const built = { A: 1, B: 1 };
    expect(since(built, { A: 1, B: 1 })).toEqual({});
  });

  it('sees ONLY the second upsell, not the shirts already on the order', () => {
    const built = { A: 1, B: 1 };
    expect(since(built, { A: 1, B: 1, C: 1 })).toEqual({ C: 1 });
  });

  it('sees a repeat of a shirt already there as one more, not a whole reprint', () => {
    const built = { A: 1 };
    expect(since(built, { A: 2 })).toEqual({ A: 1 });
  });

  it('treats a removed item as nothing to add, leaving refunds to the refund flow', () => {
    const built = { A: 1, B: 1 };
    expect(since(built, { A: 1 })).toEqual({});
  });
});
