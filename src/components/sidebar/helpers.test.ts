import { describe, it, expect } from 'vitest';
import {
  displaySize,
  isPrintifyInProduction,
  colorToHex,
  getColorOption,
  getTrackingStatus,
  getDisplayTrackingStatus,
  trackingBadgeVariant,
  getMatchScore,
  findSearchVariant,
  findSearchVariantByValues,
  findSearchVariantByTitle,
  getOptionValues,
  getAddressDisplayName,
  formatUsAddress,
} from './helpers';
import type { ShopifyOrder, PrintifyOrderMatch } from './types';

const order = (over: Partial<ShopifyOrder> = {}): ShopifyOrder => ({
  id: '1',
  legacyResourceId: '1',
  name: '#1',
  createdAt: '2026-06-01',
  financialStatus: 'PAID',
  fulfillmentStatus: null,
  totalPrice: '44.00',
  totalPriceCurrency: 'USD',
  lineItems: [],
  fulfillments: [],
  tags: [],
  ...over,
});

describe('displaySize', () => {
  it('canonicalizes to uppercase, leaves unknowns', () => {
    expect(displaySize('1x')).toBe('XL');
    expect(displaySize('medium')).toBe('M');
    expect(displaySize('One Size')).toBe('One Size');
    expect(displaySize(undefined)).toBeUndefined();
  });
});

describe('getTrackingStatus precedence', () => {
  it('delivered fulfillment wins', () => {
    expect(getTrackingStatus(order({ fulfillments: [{ id: 'f', status: 'delivered' }] }))).toBe('Delivered');
  });
  it('fulfilled with tracking = Shipped, without = Fulfilled', () => {
    expect(getTrackingStatus(order({ fulfillmentStatus: 'fulfilled', fulfillments: [{ id: 'f', status: 's', trackingNumber: 'T' }] }))).toBe('Shipped');
    expect(getTrackingStatus(order({ fulfillmentStatus: 'fulfilled', fulfillments: [{ id: 'f', status: 's' }] }))).toBe('Fulfilled');
  });
  it('partial = Partially shipped; tracking-only = In transit; else Processing', () => {
    expect(getTrackingStatus(order({ fulfillmentStatus: 'partial' }))).toBe('Partially shipped');
    expect(getTrackingStatus(order({ fulfillments: [{ id: 'f', status: 's', trackingNumber: 'T' }] }))).toBe('In transit');
    expect(getTrackingStatus(order())).toBe('Processing');
  });
});

describe('getDisplayTrackingStatus prefers carrier status', () => {
  it('maps carrier states', () => {
    expect(getDisplayTrackingStatus(order(), 'in_transit')).toBe('In transit');
    expect(getDisplayTrackingStatus(order(), 'info_received')).toBe('Label created');
    expect(getDisplayTrackingStatus(order(), 'delivered')).toBe('Delivered');
  });
  it('falls back to order-derived status when no carrier status', () => {
    expect(getDisplayTrackingStatus(order({ fulfillmentStatus: 'fulfilled', fulfillments: [{ id: 'f', status: 's', trackingNumber: 'T' }] }))).toBe('Shipped');
  });
});

describe('trackingBadgeVariant', () => {
  it('colors by status', () => {
    expect(trackingBadgeVariant('Delivered')).toBe('success');
    expect(trackingBadgeVariant('In transit')).toBe('info');
    expect(trackingBadgeVariant('Processing')).toBe('warning');
  });
});

describe('isPrintifyInProduction', () => {
  const match = (lineStatuses: string[], status = 'pending'): PrintifyOrderMatch => ({
    shopifyOrderId: '1',
    order: {
      id: 'p1',
      status,
      address_to: {},
      line_items: lineStatuses.map((s) => ({ status: s })),
      shipments: [],
    },
    productionStatus: status,
    matchMethod: 'email',
    matchConfidence: 1,
  });
  it('true when any line item or the order is in a shipped state', () => {
    expect(isPrintifyInProduction(match(['fulfilled']))).toBe(true);
    expect(isPrintifyInProduction(match(['pending'], 'shipping'))).toBe(true);
  });
  it('false when nothing has progressed, or no order', () => {
    expect(isPrintifyInProduction(match(['pending']))).toBe(false);
    expect(isPrintifyInProduction(undefined)).toBe(false);
  });
});

describe('colorToHex / getColorOption', () => {
  it('passes through hex, maps names, null for unknown', () => {
    expect(colorToHex('#abcdef')).toBe('#abcdef');
    expect(colorToHex('Navy')).toBe('#1e3a8a');
    expect(colorToHex('chartreuse')).toBeNull();
  });
  it('pulls the color option by name', () => {
    expect(getColorOption([{ name: 'Color', value: 'Red' }, { name: 'Size', value: 'M' }])).toBe('Red');
    expect(getColorOption([{ name: 'Size', value: 'M' }])).toBeNull();
  });
});

describe('getMatchScore', () => {
  it('ranks exact > prefix > substring > none', () => {
    expect(getMatchScore('Bison', 'bison')).toBe(100);
    expect(getMatchScore('Bison Tee', 'bison')).toBe(80);
    expect(getMatchScore('The Bison', 'bison')).toBe(50);
    expect(getMatchScore('Rock', 'bison')).toBe(0);
  });
});

describe('variant matching', () => {
  const variants = [
    { selectedOptions: [{ name: 'Color', value: 'Blue' }, { name: 'Size', value: 'M' }], title: 'Blue / M' },
    { selectedOptions: [{ name: 'Color', value: 'Blue' }, { name: 'Size', value: 'L' }], title: 'Blue / L' },
  ];
  it('findSearchVariant matches by option name + value', () => {
    expect(findSearchVariant(variants, 'Color', 'Size', 'Blue', 'L')?.title).toBe('Blue / L');
  });
  it('findSearchVariantByValues matches on value regardless of option name', () => {
    expect(findSearchVariantByValues(variants, 'blue', 'm')?.title).toBe('Blue / M');
  });
  it('findSearchVariantByTitle matches on the title text', () => {
    // 'm' is not a substring of 'blue', so this unambiguously hits Blue / M
    expect(findSearchVariantByTitle(variants, 'blue', 'm')?.title).toBe('Blue / M');
    expect(findSearchVariantByTitle(variants)).toBeUndefined();
  });
  it('getOptionValues collects distinct values for an option', () => {
    const fullVariants = [
      { id: '1', title: 'Blue / M', price: '40', availableForSale: true, selectedOptions: [{ name: 'Size', value: 'M' }] },
      { id: '2', title: 'Blue / L', price: '40', availableForSale: true, selectedOptions: [{ name: 'Size', value: 'L' }] },
    ];
    expect(getOptionValues(fullVariants, 'Size').sort()).toEqual(['L', 'M']);
  });
});

describe('address formatting', () => {
  it('getAddressDisplayName prefers name, then first+last', () => {
    expect(getAddressDisplayName({ name: 'Jane Doe' })).toBe('Jane Doe');
    expect(getAddressDisplayName({ firstName: 'Jane', lastName: 'Doe' })).toBe('Jane Doe');
    expect(getAddressDisplayName({})).toBeNull();
  });
  it('formatUsAddress builds clean lines and drops blanks', () => {
    const lines = formatUsAddress({ name: 'Jane Doe', address1: '1 St', city: 'Austin', provinceCode: 'TX', zip: '78701', country: 'US' });
    expect(lines).toContain('Jane Doe');
    expect(lines).toContain('1 St');
    expect(lines).toContain('Austin, TX 78701');
    expect(lines).toContain('US');
  });
});
