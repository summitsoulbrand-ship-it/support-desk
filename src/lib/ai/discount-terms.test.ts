import { describe, it, expect } from 'vitest';
import {
  parseDiscountTerms,
  describeConditions,
  diagnoseOrder,
} from './discount-terms';
import type { RawDiscountNode, ShopifyOrder } from '@/lib/shopify/types';

/**
 * The real LABOR1195 payload, copied from the live Admin API on 2026-09-07 -
 * the send that produced twelve confused customers and prompted this module.
 */
const LABOR1195: RawDiscountNode = {
  codeDiscount: {
    __typename: 'DiscountCodeBasic',
    title: 'Labor Day Store Credit - Sep 2026',
    status: 'ACTIVE',
    startsAt: '2026-09-05T07:00:00Z',
    endsAt: '2026-09-08T06:59:59Z',
    appliesOncePerCustomer: true,
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
    customerGets: {
      value: {
        __typename: 'DiscountAmount',
        amount: { amount: '11.95', currencyCode: 'USD' },
        appliesOnEachItem: false,
      },
      items: {
        __typename: 'DiscountCollections',
        collections: {
          nodes: [
            {
              title: 'Store Credit Eligible (internal)',
              ruleSet: {
                appliedDisjunctively: false,
                rules: [
                  { column: 'TYPE', relation: 'NOT_EQUALS', condition: 'Gift Card' },
                  { column: 'TAG', relation: 'NOT_EQUALS', condition: 'on-sale' },
                ],
              },
            },
          ],
        },
      },
    },
    minimumRequirement: {
      __typename: 'DiscountMinimumQuantity',
      greaterThanOrEqualToQuantity: '2',
    },
  },
};

const order = (over: Partial<ShopifyOrder> = {}) =>
  ({
    createdAt: '2026-09-05T18:13:32Z',
    discountCodes: [],
    lineItems: [{ quantity: 1 }],
    ...over,
  }) as unknown as ShopifyOrder;

describe('parseDiscountTerms', () => {
  it('reads the real store-credit code', () => {
    const t = parseDiscountTerms('labor1195', LABOR1195)!;
    expect(t.code).toBe('LABOR1195');
    expect(t.value).toBe('$11.95 off');
    expect(t.minimumQuantity).toBe(2);
    expect(t.excludesSaleItems).toBe(true);
    expect(t.combinesWithOtherCodes).toBe(false);
    expect(t.oncePerCustomer).toBe(true);
  });

  it('does not call a sale-exclusion collection a product restriction', () => {
    // The eligible collection is everything EXCEPT sale items and gift cards.
    // Telling a customer it "only applies to selected products" would send
    // them hunting through the catalog for nothing.
    expect(parseDiscountTerms('labor1195', LABOR1195)!.limitedToSomeProducts).toBe(false);
  });

  it('does flag a genuinely hand-picked product list', () => {
    const t = parseDiscountTerms('PICKED', {
      codeDiscount: {
        __typename: 'DiscountCodeBasic',
        status: 'ACTIVE',
        customerGets: {
          value: { __typename: 'DiscountPercentage', percentage: 0.2 },
          items: { __typename: 'DiscountProducts', products: { nodes: [{ title: 'One Tee' }] } },
        },
      },
    })!;
    expect(t.limitedToSomeProducts).toBe(true);
    expect(t.value).toBe('20% off');
  });

  it('reads a percentage as a percentage, not a fraction', () => {
    const t = parseDiscountTerms('WELCOME15', {
      codeDiscount: {
        __typename: 'DiscountCodeBasic',
        status: 'ACTIVE',
        customerGets: { value: { __typename: 'DiscountPercentage', percentage: 0.15 } },
      },
    })!;
    expect(t.value).toBe('15% off');
  });

  it('returns null for a code the store does not have', () => {
    expect(parseDiscountTerms('NOPE', null)).toBeNull();
    expect(parseDiscountTerms('NOPE', { codeDiscount: null })).toBeNull();
  });
});

describe('describeConditions', () => {
  it('dates the deadline in the store timezone the promo was set in', () => {
    const lines = describeConditions(parseDiscountTerms('LABOR1195', LABOR1195)!);
    expect(lines.some((l) => l.includes('September 7, 2026'))).toBe(true);
  });

  it('states the conditions a customer can act on', () => {
    const lines = describeConditions(parseDiscountTerms('LABOR1195', LABOR1195)!);
    expect(lines).toContain('It needs at least 2 items in the cart.');
    expect(lines).toContain('It does not apply to items that are already on sale.');
    expect(lines).toContain('It cannot be combined with another discount code.');
  });

  it('never leaks the internal collection name', () => {
    const lines = describeConditions(parseDiscountTerms('LABOR1195', LABOR1195)!).join(' ');
    expect(lines).not.toMatch(/internal|on-sale|Store Credit Eligible/);
  });
});

describe('diagnoseOrder', () => {
  const terms = parseDiscountTerms('LABOR1195', LABOR1195)!;

  it('names the real reason on the order that started this', () => {
    // Leon's #37608: one Bee Kind Premium, code needs two items.
    expect(diagnoseOrder(terms, order()).reason).toBe(
      'This order has 1 item and the code needs at least 2.'
    );
  });

  it('counts quantity, not line count', () => {
    const two = order({ lineItems: [{ quantity: 2 }] as never });
    expect(diagnoseOrder(terms, two).reason).toBeNull();
  });

  it('says nothing to apologize for when the code did apply', () => {
    const used = order({ lineItems: [{ quantity: 2 }] as never, discountCodes: ['LABOR1195'] });
    expect(diagnoseOrder(terms, used)).toEqual({ reason: null, applied: true });
  });

  it('explains an order placed after the code ended', () => {
    const late = order({ lineItems: [{ quantity: 3 }] as never, createdAt: '2026-09-10T12:00:00Z' });
    // 06:59:59Z is 23:59:59 Pacific on the 7th - the deadline the marketing
    // email actually gave ("midnight tonight"), not the following day.
    expect(diagnoseOrder(terms, late).reason).toContain('ended on September 7, 2026');
  });

  it('explains a code that could not stack with the one already used', () => {
    const other = order({ lineItems: [{ quantity: 3 }] as never, discountCodes: ['WELCOME15'] });
    expect(diagnoseOrder(terms, other).reason).toContain('cannot be combined');
  });

  it('refuses to guess when no condition is provably missed', () => {
    const fine = order({ lineItems: [{ quantity: 4 }] as never });
    expect(diagnoseOrder(terms, fine).reason).toBeNull();
  });

  it('refuses to guess with no order at all', () => {
    expect(diagnoseOrder(terms, null)).toEqual({ reason: null, applied: false });
  });
});
