/**
 * Combined shipments. Every case here is a refund-while-it-prints scenario if
 * it regresses: the desk has to recognise a combined order from the tags the
 * order combiner writes, and must never read "could not find it" as "nothing
 * is printing". Tag strings are the real ones off #38526 / #38547.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCombinedTags,
  isCombinedPrintifyLabel,
  combinedStateOf,
  combinedActionMessage,
} from './combined';
import type { PrintifyOrder } from '@/lib/printify/types';

const po = (over: Partial<PrintifyOrder> = {}): PrintifyOrder =>
  ({
    id: '6aa62e81f94c008328088f77',
    status: 'on-hold',
    line_items: [{ status: 'on-hold' }],
    ...over,
  }) as unknown as PrintifyOrder;

describe('parseCombinedTags', () => {
  it('is null for an order the combiner never touched', () => {
    expect(parseCombinedTags({ name: '#100', tags: ['Kaching Upsell', 'vip'] })).toBeNull();
    expect(parseCombinedTags({ name: '#100', tags: [] })).toBeNull();
    expect(parseCombinedTags({ name: '#100', tags: null })).toBeNull();
  });

  it('reads the survivor: its own name and the Printify id from combined-po-', () => {
    const c = parseCombinedTags({
      name: '#38526',
      tags: ['combined-po-6aa62e81f94c008328088f77', 'combined-primary', 'tracking-copied'],
    });
    expect(c).toEqual({
      survivorName: '#38526',
      printifyOrderId: '6aa62e81f94c008328088f77',
      isSurvivor: true,
    });
  });

  it('reads a duplicate: the survivor it was folded into, and no Printify id of its own', () => {
    const c = parseCombinedTags({
      name: '#38547',
      tags: ['combined-into-#38526', 'combined-shipment', 'Kaching Upsell', 'tracking-copied'],
    });
    expect(c).toEqual({ survivorName: '#38526', printifyOrderId: null, isSurvivor: false });
  });

  it('tolerates stray spaces and case, the way Shopify hands tags back', () => {
    const c = parseCombinedTags({ name: '#2', tags: [' Combined-Into-#1 ', 'COMBINED-SHIPMENT'] });
    expect(c?.survivorName).toBe('#1');
  });

  it('still counts as combined mid-run, before the survivor tag lands (fail closed)', () => {
    // The combiner tags the duplicates first and the survivor LAST. In between,
    // a duplicate knows its survivor but nobody knows the Printify id yet.
    const c = parseCombinedTags({ name: '#2', tags: ['combined-shipment'] });
    expect(c).not.toBeNull();
    expect(c?.survivorName).toBeNull();
    expect(c?.printifyOrderId).toBeNull();
  });
});

describe('isCombinedPrintifyLabel', () => {
  it('matches the label the combiner writes and nothing else', () => {
    expect(isCombinedPrintifyLabel('#38526 (combined)')).toBe(true);
    expect(isCombinedPrintifyLabel('#38526')).toBe(false);
    expect(isCombinedPrintifyLabel(null)).toBe(false);
  });
});

describe('combinedStateOf', () => {
  it('unreadable is unknown, never "fine"', () => {
    expect(combinedStateOf(null)).toBe('unknown');
  });
  it('on hold while nothing has gone to production', () => {
    expect(combinedStateOf(po())).toBe('on-hold');
  });
  it('in production once Printify has sent it', () => {
    expect(combinedStateOf(po({ sent_to_production_at: '2026-09-13 07:37:35' } as Partial<PrintifyOrder>))).toBe(
      'in-production'
    );
    expect(
      combinedStateOf(po({ line_items: [{ status: 'in-production' }] } as unknown as Partial<PrintifyOrder>))
    ).toBe('in-production');
  });
  it('cancelled is its own state - the only one where a plain refund is safe', () => {
    expect(combinedStateOf(po({ status: 'canceled' }))).toBe('cancelled');
    expect(combinedStateOf(po({ status: 'cancelled' }))).toBe('cancelled');
  });
});

describe('combinedActionMessage', () => {
  it('names both orders and says what to do instead of just refusing', () => {
    const msg = combinedActionMessage('#38547', { survivorName: '#38526', state: 'on-hold' }, 'cancel');
    expect(msg).toContain('#38547');
    expect(msg).toContain('#38526');
    expect(msg).toMatch(/remove #38547's items/);
    expect(msg).toMatch(/THEN come back and refund/);
  });
  it('does not name the order as its own partner when it IS the survivor', () => {
    const msg = combinedActionMessage('#38526', { survivorName: '#38526', state: 'on-hold' }, 'address');
    expect(msg).toContain('another order from the same customer');
    expect(msg).not.toContain('together with #38526');
  });
  it('an unreadable combined order is described as possibly printing', () => {
    const msg = combinedActionMessage('#2', { survivorName: '#1', state: 'unknown' }, 'cancel');
    expect(msg).toMatch(/assume it is printing/);
  });
  it('never uses an em dash (brand rule)', () => {
    for (const state of ['on-hold', 'in-production', 'unknown'] as const) {
      for (const action of ['cancel', 'address', 'item'] as const) {
        expect(combinedActionMessage('#2', { survivorName: '#1', state }, action)).not.toMatch(/—/);
      }
    }
  });
});
