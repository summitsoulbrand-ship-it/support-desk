import { describe, it, expect } from 'vitest';
import { normalizeMailingAddress, mapOrderNode, type OrderNode } from './mappers';

const money = (amount: string, currencyCode = 'USD') => ({ shopMoney: { amount, currencyCode } });

function baseOrder(over: Partial<OrderNode> = {}): OrderNode {
  return {
    id: 'gid://shopify/Order/1',
    name: '#1001',
    legacyResourceId: '1001',
    email: 'a@b.com',
    createdAt: '2026-06-01',
    updatedAt: '2026-06-02',
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    totalPriceSet: money('44.00'),
    subtotalPriceSet: money('40.00'),
    totalShippingPriceSet: money('4.00'),
    totalTaxSet: money('0.00'),
    tags: [],
    lineItems: { edges: [] },
    fulfillments: [],
    metafields: { edges: [] },
    ...over,
  };
}

const lineItem = (over: Record<string, unknown> = {}) => ({
  node: {
    id: 'li1',
    title: 'Bison Tee',
    quantity: 1,
    originalUnitPriceSet: money('40.00'),
    ...over,
  },
});

describe('mapOrderNode', () => {
  it('prefers the current total over the original (reflects order edits)', () => {
    const o = mapOrderNode(baseOrder({ totalPriceSet: money('44.00'), currentTotalPriceSet: money('22.00') }));
    expect(o.totalPrice).toBe('22.00');
  });

  it('falls back to the original total when there is no current total', () => {
    expect(mapOrderNode(baseOrder()).totalPrice).toBe('44.00');
  });

  it('hides line items fully removed by an order edit (currentQuantity 0)', () => {
    const o = mapOrderNode(
      baseOrder({
        lineItems: {
          edges: [
            lineItem({ id: 'keep', currentQuantity: 1 }),
            lineItem({ id: 'removed', currentQuantity: 0 }),
          ],
        },
      })
    );
    expect(o.lineItems.map((l) => l.id)).toEqual(['keep']);
  });

  it('uses currentQuantity over the original quantity', () => {
    const o = mapOrderNode(
      baseOrder({ lineItems: { edges: [lineItem({ quantity: 3, currentQuantity: 2 })] } })
    );
    expect(o.lineItems[0].quantity).toBe(2);
  });

  it('computes discounted unit price = original minus per-unit discount', () => {
    const o = mapOrderNode(
      baseOrder({
        lineItems: {
          edges: [
            lineItem({
              quantity: 2,
              originalUnitPriceSet: money('40.00'),
              discountAllocations: [{ allocatedAmountSet: { shopMoney: { amount: '20.00' } } }],
            }),
          ],
        },
      })
    );
    // 40 - (20 / 2) = 30.00
    expect(o.lineItems[0].discountedUnitPrice).toBe('30.00');
  });

  it('maps the first tracking entry of each fulfillment', () => {
    const o = mapOrderNode(
      baseOrder({
        fulfillments: [
          {
            id: 'f1',
            status: 'SUCCESS',
            trackingInfo: [{ number: 'TN1', url: 'http://t', company: 'DHL' }],
            createdAt: 'x',
            updatedAt: 'y',
            fulfillmentLineItems: { edges: [{ node: { id: 'fli', quantity: 1, lineItem: { id: 'li1' } } }] },
          },
        ],
      })
    );
    expect(o.fulfillments[0].trackingNumber).toBe('TN1');
    expect(o.fulfillments[0].trackingCompany).toBe('DHL');
  });

  it('exposes countryCode from countryCodeV2 on the shipping address', () => {
    const o = mapOrderNode(
      baseOrder({ shippingAddress: { city: 'Austin', countryCodeV2: 'US' } })
    );
    expect(o.shippingAddress?.countryCode).toBe('US');
  });
});

describe('normalizeMailingAddress', () => {
  it('returns undefined for null/empty', () => {
    expect(normalizeMailingAddress(null)).toBeUndefined();
    expect(normalizeMailingAddress({})).toBeUndefined();
  });

  it('keeps explicit first/last names', () => {
    const r = normalizeMailingAddress({ firstName: 'Jane', lastName: 'Doe', address1: '1 St' });
    expect(r).toMatchObject({ firstName: 'Jane', lastName: 'Doe', address1: '1 St' });
  });

  it('splits a full name into first and last when not provided', () => {
    const r = normalizeMailingAddress({ name: 'Jane Q Doe', address1: '1 St' });
    expect(r?.firstName).toBe('Jane');
    expect(r?.lastName).toBe('Q Doe');
  });

  it('uses a single-word name for both first and last', () => {
    const r = normalizeMailingAddress({ name: 'Cher' });
    expect(r?.firstName).toBe('Cher');
    expect(r?.lastName).toBe('Cher');
  });

  it('prefers countryCode, falls back to countryCodeV2', () => {
    expect(normalizeMailingAddress({ city: 'X', countryCodeV2: 'US' })?.countryCode).toBe('US');
    expect(normalizeMailingAddress({ city: 'X', countryCode: 'CA', countryCodeV2: 'US' })?.countryCode).toBe('CA');
  });

  it('falls back to province when no provinceCode', () => {
    const r = normalizeMailingAddress({ city: 'X', province: 'California' });
    expect(r?.province).toBe('California');
    expect(r?.provinceCode).toBeUndefined();
  });

  it('trims whitespace and drops blank fields', () => {
    const r = normalizeMailingAddress({ firstName: '  Jane  ', address1: '   ', city: 'Austin' });
    expect(r?.firstName).toBe('Jane');
    expect(r?.address1).toBeUndefined();
    expect(r?.city).toBe('Austin');
  });
});
