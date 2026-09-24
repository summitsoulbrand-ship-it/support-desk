/**
 * Printify reprints -> the original Shopify order. Shapes copied from real
 * orders read 2026-09-24 (people's names and streets left out).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  REPRINT_HOLD_HOURS,
  REPRINT_LINK_WINDOW_DAYS,
  heldTooLong,
  holdWords,
  printifyOrderUrl,
  reprintOnHoldMessage,
  reprintParentId,
  reprintSkipReason,
  reprintStage,
  resolveReprintTarget,
  sameRecipient,
  shopifyNameFromLabel,
  summarizeReprint,
  type ReprintDeps,
} from './reprint';
import type { PrintifyOrder } from './types';

const NOW = new Date('2026-09-24T12:00:00Z');

function order(p: Partial<PrintifyOrder> & { id: string }): PrintifyOrder {
  return {
    status: 'fulfilled',
    created_at: '2026-09-18 05:20:00+00:00',
    address_to: { first_name: 'Ann', last_name: 'Buyer', zip: '79606', country: 'United States' },
    line_items: [],
    shipments: [],
    total_price: 0,
    total_shipping: 0,
    total_tax: 0,
    ...p,
  } as PrintifyOrder;
}

// The reprint Printify makes: a MANUAL order, no Shopify link, parent named.
const reprint = (p: Partial<PrintifyOrder> = {}) =>
  order({
    id: 'reprint',
    app_order_id: '19269685.39876',
    metadata: { order_type: 'manual', is_reprint: true, reprinted_order_ids: ['parent'] },
    ...p,
  });

// The order it reprints, as Printify's store sync filed it.
const storeOrder = (p: Partial<PrintifyOrder> = {}) =>
  order({
    id: 'parent',
    created_at: '2026-09-04 10:00:00+00:00',
    metadata: { order_type: 'api', shop_order_id: '6093178273944', shop_order_label: '#38075' },
    ...p,
  });

function deps(orders: PrintifyOrder[], shopify: Record<string, string> = {}): ReprintDeps {
  const byId = new Map(orders.map((o) => [o.id, o]));
  return {
    getOrder: vi.fn(async (id: string) => byId.get(id) ?? null),
    // shopify maps gid or name -> the order name Shopify answers with
    getShopifyOrderById: vi.fn(async (gid: string) =>
      shopify[gid] ? { id: gid, name: shopify[gid] } : null
    ),
    getShopifyOrderByName: vi.fn(async (name: string) =>
      shopify[name] ? { id: `gid://shopify/Order/by-name-${name}`, name: shopify[name] } : null
    ),
  };
}

describe('reprintParentId', () => {
  it('reads the parent Printify names on a reprint', () => {
    expect(reprintParentId(reprint())).toBe('parent');
  });
  it('is null on an ordinary store order', () => {
    expect(reprintParentId(storeOrder())).toBeNull();
  });
});

describe('shopifyNameFromLabel', () => {
  it('takes the plain order name', () => {
    expect(shopifyNameFromLabel('#38075')).toBe('#38075');
  });
  it('takes the earliest order out of a combined label', () => {
    expect(shopifyNameFromLabel('#30307 (combined)')).toBe('#30307');
  });
  it('refuses anything else', () => {
    expect(shopifyNameFromLabel(undefined)).toBeNull();
    expect(shopifyNameFromLabel('sample for photos')).toBeNull();
  });
});

describe('reprintSkipReason', () => {
  it('links a reprint that is still printing or on its way', () => {
    expect(reprintSkipReason(reprint({ status: 'in-production' }), NOW)).toBeNull();
    expect(
      reprintSkipReason(
        reprint({ shipments: [{ carrier: 'DHL', number: '9261290223382099960691' }] }),
        NOW
      )
    ).toBeNull();
  });

  it('leaves a delivered reprint alone - the customer already has it', () => {
    const r = reprint({
      shipments: [
        { carrier: 'DHL', number: '1', delivered_at: '2026-09-22 18:00:00+00:00' },
      ],
    });
    expect(reprintSkipReason(r, NOW)).toBe('delivered');
  });

  it('still links when only one of two parcels has arrived', () => {
    const r = reprint({
      shipments: [
        { carrier: 'DHL', number: '1', delivered_at: '2026-09-22 18:00:00+00:00' },
        { carrier: 'DHL', number: '2' },
      ],
    });
    expect(reprintSkipReason(r, NOW)).toBeNull();
  });

  it('leaves cancelled and old reprints alone', () => {
    expect(reprintSkipReason(reprint({ status: 'canceled' }), NOW)).toBe('cancelled');
    const old = new Date(NOW.getTime() - (REPRINT_LINK_WINDOW_DAYS + 1) * 86400000);
    const stamp = old.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+00:00');
    expect(reprintSkipReason(reprint({ created_at: stamp }), NOW)).toBe('too-old');
  });

  it('is not-a-reprint on a store order', () => {
    expect(reprintSkipReason(storeOrder(), NOW)).toBe('not-a-reprint');
  });
});

describe('sameRecipient', () => {
  it('matches on ZIP, including ZIP+4 against 5 digits', () => {
    expect(sameRecipient({ zip: '79606-1234' }, { zip: '79606' })).toBe(true);
  });
  it('matches the same person at a new address', () => {
    expect(
      sameRecipient(
        { first_name: 'Ann', last_name: 'Buyer', zip: '10001' },
        { first_name: 'ann', last_name: 'buyer ', zip: '79606' }
      )
    ).toBe(true);
  });
  it('refuses a different person at a different address', () => {
    expect(
      sameRecipient(
        { first_name: 'Shop', last_name: 'Owner', zip: '92648' },
        { first_name: 'Ann', last_name: 'Buyer', zip: '79606' }
      )
    ).toBe(false);
  });
  it('does not treat two blanked-out names as the same person', () => {
    const blank = { first_name: 'PII_DELETED', last_name: 'PII_DELETED' };
    expect(sameRecipient({ ...blank, zip: '10001' }, { ...blank, zip: '79606' })).toBe(false);
  });
});

describe('resolveReprintTarget', () => {
  it('follows Printify from the reprint to the Shopify order the parent names', async () => {
    const d = deps([storeOrder()], { 'gid://shopify/Order/6093178273944': '#38075' });
    const t = await resolveReprintTarget(reprint(), d);
    expect(t).toEqual({
      ok: true,
      parentId: 'parent',
      shopifyOrderId: 'gid://shopify/Order/6093178273944',
      shopifyOrderName: '#38075',
    });
    expect(d.getShopifyOrderByName).not.toHaveBeenCalled();
  });

  it('looks a desk rebuild up by name - its shop_order_id is "<n>-R<time>"', async () => {
    const parent = storeOrder({
      metadata: { order_type: 'api', shop_order_id: '37037-R1788296328584', shop_order_label: '#37037' },
    });
    const t = await resolveReprintTarget(reprint(), deps([parent], { '#37037': '#37037' }));
    expect(t.ok && t.shopifyOrderName).toBe('#37037');
  });

  it('files a reprint of a combined box under its earliest order', async () => {
    const parent = storeOrder({
      metadata: {
        order_type: 'api',
        shop_order_id: '#30307-combined-2026-07-21',
        shop_order_label: '#30307 (combined)',
      },
    });
    const t = await resolveReprintTarget(reprint(), deps([parent], { '#30307': '#30307' }));
    expect(t.ok && t.shopifyOrderName).toBe('#30307');
  });

  it('walks up through a reprint of a reprint', async () => {
    const middle = order({
      id: 'parent',
      metadata: { order_type: 'manual', is_reprint: true, reprinted_order_ids: ['grand'] },
    });
    const grand = storeOrder({ id: 'grand' });
    const t = await resolveReprintTarget(
      reprint(),
      deps([middle, grand], { 'gid://shopify/Order/6093178273944': '#38075' })
    );
    expect(t).toMatchObject({ ok: true, parentId: 'parent', shopifyOrderName: '#38075' });
  });

  it('refuses when Shopify answers with a different order', async () => {
    const t = await resolveReprintTarget(
      reprint(),
      deps([storeOrder()], { 'gid://shopify/Order/6093178273944': '#38076' })
    );
    expect(t.ok).toBe(false);
  });

  it('refuses a reprint sent to someone else', async () => {
    const sample = reprint({
      address_to: { first_name: 'Shop', last_name: 'Owner', zip: '92648' },
    });
    const d = deps([storeOrder()], { 'gid://shopify/Order/6093178273944': '#38075' });
    const t = await resolveReprintTarget(sample, d);
    expect(t.ok).toBe(false);
    expect(d.getShopifyOrderById).not.toHaveBeenCalled();
  });

  it('says so when the original cannot be read, rather than guessing', async () => {
    const t = await resolveReprintTarget(reprint(), deps([]));
    expect(t).toEqual({ ok: false, reason: 'original Printify order parent could not be read' });
  });

  it('refuses when nothing up the chain names a Shopify order', async () => {
    const handMade = order({ id: 'parent', metadata: { order_type: 'manual' } });
    const t = await resolveReprintTarget(reprint(), deps([handMade]));
    expect(t).toEqual({ ok: false, reason: 'no Shopify order behind this reprint' });
  });
});

describe('summarizeReprint', () => {
  it('says a reprint that never left on-hold is waiting, not printing (#38075, 09-18)', () => {
    const s = summarizeReprint(
      reprint({
        status: 'on-hold',
        created_at: '2026-09-18 01:33:07+00:00',
        line_items: [
          {
            quantity: 1,
            status: 'on-hold',
            metadata: { title: 'Retired and Unsupervised Premium', variant_label: 'Graphite / XL' },
          },
        ] as PrintifyOrder['line_items'],
      }),
      '#38075'
    );
    expect(s).toMatchObject({
      stage: 'waiting',
      forOrderName: '#38075',
      createdAt: '2026-09-18T01:33:07.000Z',
      items: ['Retired and Unsupervised Premium - Graphite / XL'],
      tracking: null,
    });
  });

  it('carries the new parcel once it ships, then says delivered when it lands', () => {
    const shipped = reprint({
      status: 'fulfilled',
      line_items: [
        { quantity: 2, status: 'shipment_in_transit', metadata: { title: 'Surrender Premium', variant_label: 'Graphite / L' } },
      ] as PrintifyOrder['line_items'],
      shipments: [
        { carrier: 'DHL', number: '9261290223382099960691', url: 'https://t/1', shipped_at: '2026-09-19 10:00:00+00:00' },
      ],
    });
    const s = summarizeReprint(shipped, '#37037');
    expect(s.stage).toBe('shipped');
    expect(s.items).toEqual(['Surrender Premium - Graphite / L (x2)']);
    expect(s.tracking).toMatchObject({ carrier: 'DHL', number: '9261290223382099960691', url: 'https://t/1' });

    const landed = summarizeReprint(
      { ...shipped, shipments: [{ ...shipped.shipments[0], delivered_at: '2026-09-23 18:00:00+00:00' }] },
      '#37037'
    );
    expect(landed.stage).toBe('delivered');
    expect(landed.tracking?.deliveredAt).toBe('2026-09-23T18:00:00.000Z');
  });

  it('calls a reprint in production printing', () => {
    expect(reprintStage(reprint({ status: 'in-production' }))).toBe('printing');
  });
});

describe('heldTooLong', () => {
  // #38075's reprint as it sat 09-18 to 09-24: made, never submitted.
  const held = (p: Partial<PrintifyOrder> = {}) =>
    reprint({
      status: 'on-hold',
      created_at: '2026-09-18 01:33:31+00:00',
      line_items: [
        { quantity: 1, status: 'on-hold', metadata: { title: 'Retired and Unsupervised Premium' } },
      ] as PrintifyOrder['line_items'],
      ...p,
    });

  it('flags a reprint still on hold days after it was made', () => {
    expect(heldTooLong(held(), NOW)).toBe(true);
  });

  it(`leaves a reprint alone for its first ${REPRINT_HOLD_HOURS} hours`, () => {
    const justMade = new Date(NOW.getTime() - 30 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '+00:00');
    expect(heldTooLong(held({ created_at: justMade }), NOW)).toBe(false);
  });

  it('is quiet once it has gone to print', () => {
    expect(heldTooLong(held({ status: 'in-production' }), NOW)).toBe(false);
    expect(
      heldTooLong(held({ sent_to_production_at: '2026-09-24 20:41:42+00:00' }), NOW)
    ).toBe(false);
  });

  it('ignores ordinary store orders waiting for the nightly print run', () => {
    expect(heldTooLong(storeOrder({ status: 'on-hold' }), NOW)).toBe(false);
  });
});

describe('reprint on hold wording', () => {
  const r = {
    printifyOrderId: 'abc',
    appOrderId: '19269685.39851',
    forOrderName: '#38075',
    createdAt: '2026-09-18T01:33:31.000Z',
    hoursOnHold: 163,
    items: ['Retired and Unsupervised Premium - Graphite / XL'],
  };

  it('says how long in days once it is past two', () => {
    expect(holdWords(5)).toBe('5 hours');
    expect(holdWords(163)).toBe('6 days');
  });

  it('names the order, the shirt, what to click, and links the reprint', () => {
    const text = reprintOnHoldMessage(r, printifyOrderUrl('19269685', 'abc'));
    expect(text).toContain('Printify reprint for #38075 is not printing');
    expect(text).toContain('Retired and Unsupervised Premium - Graphite / XL');
    expect(text).toContain('clicks Submit');
    expect(text).toContain(
      '<https://printify.com/app/store/19269685/order/abc|Open reprint 19269685.39851 in Printify>'
    );
  });
});
