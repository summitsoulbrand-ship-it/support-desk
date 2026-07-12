/**
 * The fail-closed rules of the self-service portal. Every case here is a
 * money-losing scenario if it regresses (refunding an order that still
 * prints), so keep these green.
 */

import { describe, it, expect } from 'vitest';
import { computeEligibility, derivePortalStatus } from './orders';
import type { OrderState, PrintifyCopy } from './orders';
import type { ShopifyOrder } from '@/lib/shopify/types';
import type { PrintifyOrder } from '@/lib/printify/types';

const shopifyOrder = (over: Partial<ShopifyOrder> = {}): ShopifyOrder =>
  ({
    id: 'gid://shopify/Order/1',
    name: '#100',
    createdAt: new Date().toISOString(),
    fulfillmentStatus: null,
    fulfillments: [],
    lineItems: [],
    ...over,
  }) as unknown as ShopifyOrder;

const printifyOrder = (over: Partial<PrintifyOrder> = {}): PrintifyOrder =>
  ({
    id: 'p1',
    status: 'on-hold',
    line_items: [{ status: 'on-hold' }],
    ...over,
  }) as unknown as PrintifyOrder;

const copy = (id: string, order: PrintifyOrder | null): PrintifyCopy => ({ id, order });

describe('computeEligibility (multi-copy, fail closed)', () => {
  it('eligible when every live copy is pre-production', () => {
    const e = computeEligibility(
      shopifyOrder(),
      [copy('a', printifyOrder()), copy('b', printifyOrder({ id: 'b' }))],
      0
    );
    expect(e).toEqual({ eligible: true, reason: 'ok' });
  });

  it('blocks when ANY copy is in production, even if others are not', () => {
    const inProd = printifyOrder({
      line_items: [{ status: 'in-production' }],
    } as Partial<PrintifyOrder>);
    const e = computeEligibility(
      shopifyOrder(),
      [copy('a', printifyOrder()), copy('b', inProd)],
      0
    );
    expect(e).toEqual({ eligible: false, reason: 'in_production' });
  });

  it('blocks (needs_support) when a live copy could not be read - never guess', () => {
    const e = computeEligibility(shopifyOrder(), [copy('a', null)], 0);
    expect(e).toEqual({ eligible: false, reason: 'needs_support' });
  });

  it('blocks (needs_support) when only cancelled copies exist - a replacement may be in flight', () => {
    const e = computeEligibility(shopifyOrder(), [], 2);
    expect(e).toEqual({ eligible: false, reason: 'needs_support' });
  });

  it('no Printify trace: young order eligible, old order blocked', () => {
    expect(computeEligibility(shopifyOrder(), [], 0).eligible).toBe(true);
    const old = shopifyOrder({
      createdAt: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
    });
    expect(computeEligibility(old, [], 0)).toEqual({
      eligible: false,
      reason: 'too_late_unverified',
    });
  });

  it('cancelled and fulfilled Shopify orders are never eligible', () => {
    expect(
      computeEligibility(shopifyOrder({ cancelledAt: 'x' }), [copy('a', printifyOrder())], 0).reason
    ).toBe('already_cancelled');
    expect(
      computeEligibility(
        shopifyOrder({ fulfillmentStatus: 'FULFILLED' }),
        [copy('a', printifyOrder())],
        0
      ).reason
    ).toBe('already_fulfilled');
  });
});

describe('derivePortalStatus', () => {
  const state = (over: Partial<OrderState>): OrderState =>
    ({
      shopifyOrder: shopifyOrder(),
      printifyOrders: [],
      cancelledCopies: 0,
      printifyOrderId: null,
      eligibility: { eligible: true, reason: 'ok' },
      ...over,
    }) as OrderState;

  it('cancelled beats everything', () => {
    const s = state({ shopifyOrder: shopifyOrder({ cancelledAt: 'x' }) });
    expect(derivePortalStatus(s).status).toBe('cancelled');
  });

  it('shipped shows tracking links', () => {
    const s = state({
      shopifyOrder: shopifyOrder({
        fulfillments: [
          {
            status: 'SUCCESS',
            trackingNumber: 'TRACK1',
            trackingUrl: 'https://t.example/TRACK1',
            trackingCompany: 'USPS',
          },
        ] as unknown as ShopifyOrder['fulfillments'],
      }),
    });
    const r = derivePortalStatus(s);
    expect(r.status).toBe('shipped');
    expect(r.tracking).toEqual([
      { number: 'TRACK1', url: 'https://t.example/TRACK1', carrier: 'USPS' },
    ]);
  });

  it('eligible -> editable; in production -> printing; unverifiable -> needs_support', () => {
    expect(derivePortalStatus(state({})).status).toBe('editable');
    expect(
      derivePortalStatus(
        state({ eligibility: { eligible: false, reason: 'in_production' } })
      ).status
    ).toBe('printing');
    expect(
      derivePortalStatus(
        state({ eligibility: { eligible: false, reason: 'needs_support' } })
      ).status
    ).toBe('needs_support');
  });
});
