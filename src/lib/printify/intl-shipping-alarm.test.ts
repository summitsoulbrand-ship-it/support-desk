/**
 * Fixtures are the real orders from the 2026-08-31 audit (180 days, 26,450
 * orders scanned, 62 live international). Each one is a case the alarm has to
 * get right, including the ones it must stay quiet about.
 */
import { describe, it, expect } from 'vitest';
import { evaluateOrder } from './intl-shipping-alarm';
import { PrintifyOrder } from './types';

type Line = {
  title: string;
  variant: string;
  country: string;
  shipping: number;
  status?: string;
};

function order(
  name: string,
  country: string,
  totalShipping: number,
  lines: Line[],
  status = 'in-production'
): PrintifyOrder {
  return {
    id: `pf_${name.replace('#', '')}`,
    status,
    created_at: '2026-08-30 07:21:45+00:00',
    address_to: { country },
    total_price: 0,
    total_shipping: totalShipping,
    total_tax: 0,
    shipments: [],
    metadata: { shop_order_label: name },
    line_items: lines.map((l) => ({
      product_id: 'p',
      quantity: 1,
      variant_id: 1,
      print_provider_id: 1,
      cost: 0,
      shipping: l.shipping,
      shipping_cost: l.shipping,
      status: l.status ?? 'in-production',
      metadata: { title: l.title, variant_label: l.variant, country: l.country },
    })),
  } as unknown as PrintifyOrder;
}

describe('evaluateOrder', () => {
  it('flags a UK order printed in the US (#36739)', () => {
    const f = evaluateOrder(
      order('#36739', 'United Kingdom', 1039, [
        { title: 'I Saw A Bird Premium', variant: 'Blue Jean / M', country: 'United States', shipping: 1039 },
      ]),
      3.51,
      'shopify',
      5
    );
    expect(f).not.toBeNull();
    expect(f!.gapUsd).toBeCloseTo(6.88, 2);
    expect(f!.misroutedLines).toHaveLength(1);
    expect(f!.misroutedLines[0].printedIn).toBe('United States');
  });

  it('flags the split German order where only the sweatshirt went to the US (#32782)', () => {
    const f = evaluateOrder(
      order('#32782', 'Germany', 2148, [
        { title: 'Bigfoot Carving Premium', variant: 'Blue Jean / L', country: 'Latvia', shipping: 299 },
        { title: 'Walkin with Legends Bigfoot Sweatshirt', variant: 'L / Dark Heather', country: 'United States', shipping: 1849 },
      ]),
      4.59,
      'shopify',
      5
    );
    expect(f).not.toBeNull();
    expect(f!.gapUsd).toBeCloseTo(16.89, 2);
    // Latvia -> Germany is intra-EU and must not be called a misroute.
    expect(f!.misroutedLines).toHaveLength(1);
    expect(f!.misroutedLines[0].title).toContain('Sweatshirt');
  });

  it('flags the Australian order on the Grey/3XL line alone (#35508)', () => {
    const f = evaluateOrder(
      order('#35508', 'Australia', 2088, [
        { title: 'Surrender', variant: 'Military Green / 3XL', country: 'Australia', shipping: 839 },
        { title: 'Frog Wizard Kerfuffle Premium', variant: 'Grey / 3XL', country: 'United States', shipping: 1249 },
      ]),
      8.52,
      'shopify',
      5
    );
    expect(f!.gapUsd).toBeCloseTo(12.36, 2);
    expect(f!.misroutedLines).toHaveLength(1);
  });

  it('stays quiet on a correctly routed single-item order', () => {
    const f = evaluateOrder(
      order('#32778', 'Australia', 839, [
        { title: 'Some Tee', variant: 'Black / L', country: 'Australia', shipping: 839 },
      ]),
      6.92,
      'shopify',
      5
    );
    expect(f).toBeNull();
  });

  it('treats an Australian printer as local for New Zealand (#29849)', () => {
    const f = evaluateOrder(
      order('#29849', 'New Zealand', 1117, [
        { title: 'Some Tee', variant: 'Black / L', country: 'Australia', shipping: 1117 },
      ]),
      12.24,
      'shopify',
      5
    );
    expect(f).toBeNull();
  });

  it('ignores the canceled line Printify Choice leaves behind when it re-routes', () => {
    const f = evaluateOrder(
      order('#40000', 'United Kingdom', 350, [
        { title: 'Tee', variant: 'Black / L', country: 'United States', shipping: 700, status: 'canceled' },
        { title: 'Tee', variant: 'Black / L', country: 'United Kingdom', shipping: 350 },
      ]),
      3.5,
      'shopify',
      5
    );
    expect(f).toBeNull();
  });

  it('marks a hand-placed reorder as having no store number', () => {
    const o = order('#ignored', 'United Kingdom', 1039, [
      { title: 'I Saw A Bird Premium', variant: 'Blue Jean / M', country: 'United States', shipping: 1039 },
    ]);
    delete (o as { metadata?: unknown }).metadata;
    const f = evaluateOrder(o, 3.3, 'estimate', 5);
    expect(f!.hasStoreNumber).toBe(false);
    expect(f!.orderName).toBe(f!.printifyOrderId);
  });

  it('flags a locally printed order when per-item shipping still overruns (#12180)', () => {
    const f = evaluateOrder(
      order('#12180', 'Canada', 1538, [
        { title: 'Alien Desert Highway T-Shirt', variant: 'Dark Heather / L', country: 'Canada', shipping: 679 },
        { title: 'Alien Desert Highway Hoodie', variant: 'Dark Heather / XL', country: 'Canada', shipping: 859 },
      ]),
      6.68,
      'estimate',
      5
    );
    expect(f).not.toBeNull();
    expect(f!.misroutedLines).toHaveLength(0);
    expect(f!.gapUsd).toBeCloseTo(8.7, 2);
  });
});
