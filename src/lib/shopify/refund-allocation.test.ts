/**
 * Refund allocation across tenders. Every case here is customer money and the
 * difference between an automatic refund and a manual one - keep green.
 */

import { describe, it, expect } from 'vitest';
import {
  allocateRefundTransactions,
  RefundTxn,
} from './refund-allocation';

const sale = (id: string, amount: string, gateway = 'shopify_payments'): RefundTxn => ({
  id,
  kind: 'SALE',
  status: 'SUCCESS',
  amount,
  gateway,
});

const refund = (id: string, amount: string, parentId: string, status = 'SUCCESS'): RefundTxn => ({
  id,
  kind: 'REFUND',
  status,
  amount,
  gateway: 'shopify_payments',
  parentId,
});

describe('allocateRefundTransactions', () => {
  it('single tender: draws the whole amount from the one parent', () => {
    const txns = [sale('t1', '44.00')];
    const out = allocateRefundTransactions(txns, 44.0);
    expect(out).toEqual([{ parentId: 't1', amount: '44.00', gateway: 'shopify_payments' }]);
  });

  it('single tender partial: only the requested amount', () => {
    const out = allocateRefundTransactions([sale('t1', '44.00')], 10.5);
    expect(out).toEqual([{ parentId: 't1', amount: '10.50', gateway: 'shopify_payments' }]);
  });

  it('split tender: refund smaller than first parent stays on the first', () => {
    // gift card $20 applied first, then card $24
    const txns = [sale('gc', '20.00', 'gift_card'), sale('cc', '24.00')];
    const out = allocateRefundTransactions(txns, 15.0);
    expect(out).toEqual([{ parentId: 'gc', amount: '15.00', gateway: 'gift_card' }]);
  });

  it('split tender: refund larger than first parent spills to the second', () => {
    const txns = [sale('gc', '20.00', 'gift_card'), sale('cc', '24.00')];
    const out = allocateRefundTransactions(txns, 30.0);
    expect(out).toEqual([
      { parentId: 'gc', amount: '20.00', gateway: 'gift_card' },
      { parentId: 'cc', amount: '10.00', gateway: 'shopify_payments' },
    ]);
  });

  it('split tender: full refund drains both parents exactly', () => {
    const txns = [sale('gc', '20.00', 'gift_card'), sale('cc', '24.00')];
    const out = allocateRefundTransactions(txns, 44.0);
    expect(out).toEqual([
      { parentId: 'gc', amount: '20.00', gateway: 'gift_card' },
      { parentId: 'cc', amount: '24.00', gateway: 'shopify_payments' },
    ]);
  });

  it('respects prior refunds: a partly-refunded parent only offers its headroom', () => {
    // gc $20 already refunded $12; cc $24 untouched. Ask for $20.
    const txns = [
      sale('gc', '20.00', 'gift_card'),
      sale('cc', '24.00'),
      refund('r1', '12.00', 'gc'),
    ];
    const out = allocateRefundTransactions(txns, 20.0);
    expect(out).toEqual([
      { parentId: 'gc', amount: '8.00', gateway: 'gift_card' },
      { parentId: 'cc', amount: '12.00', gateway: 'shopify_payments' },
    ]);
  });

  it('pending refunds count against headroom too (no double refund)', () => {
    const txns = [sale('gc', '20.00', 'gift_card'), refund('r1', '20.00', 'gc', 'PENDING')];
    const out = allocateRefundTransactions(txns, 20.0);
    // gc is fully spoken for; nothing left to draw
    expect(out).toEqual([]);
  });

  it('failed refunds do NOT reduce headroom', () => {
    const txns = [sale('gc', '20.00', 'gift_card'), refund('r1', '20.00', 'gc', 'FAILURE')];
    const out = allocateRefundTransactions(txns, 20.0);
    expect(out).toEqual([{ parentId: 'gc', amount: '20.00', gateway: 'gift_card' }]);
  });

  it('caps at total headroom: never allocates more than the tenders can take', () => {
    const txns = [sale('gc', '20.00', 'gift_card'), sale('cc', '24.00')];
    const out = allocateRefundTransactions(txns, 999.0);
    const total = out.reduce((s, a) => s + parseFloat(a.amount), 0);
    expect(total).toBeCloseTo(44.0, 2);
  });

  it('skips a fully-refunded parent and uses the next', () => {
    const txns = [
      sale('gc', '20.00', 'gift_card'),
      sale('cc', '24.00'),
      refund('r1', '20.00', 'gc'),
    ];
    const out = allocateRefundTransactions(txns, 10.0);
    expect(out).toEqual([{ parentId: 'cc', amount: '10.00', gateway: 'shopify_payments' }]);
  });

  it('CAPTURE transactions are refundable just like SALE', () => {
    const txns: RefundTxn[] = [
      { id: 'c1', kind: 'CAPTURE', status: 'SUCCESS', amount: '30.00', gateway: 'shopify_payments' },
    ];
    const out = allocateRefundTransactions(txns, 30.0);
    expect(out).toEqual([{ parentId: 'c1', amount: '30.00', gateway: 'shopify_payments' }]);
  });

  it('ignores non-successful sale transactions', () => {
    const txns: RefundTxn[] = [
      { id: 't1', kind: 'SALE', status: 'FAILURE', amount: '44.00', gateway: 'shopify_payments' },
    ];
    expect(allocateRefundTransactions(txns, 44.0)).toEqual([]);
  });

  it('zero / negative target: nothing to do', () => {
    const txns = [sale('t1', '44.00')];
    expect(allocateRefundTransactions(txns, 0)).toEqual([]);
    expect(allocateRefundTransactions(txns, -5)).toEqual([]);
  });

  it('no parents at all: empty allocation', () => {
    expect(allocateRefundTransactions([], 10)).toEqual([]);
  });

  it('rounds cleanly across a three-tender split without drift', () => {
    const txns = [sale('a', '10.00', 'gift_card'), sale('b', '10.00', 'gift_card'), sale('c', '10.00')];
    const out = allocateRefundTransactions(txns, 25.33);
    const total = out.reduce((s, a) => s + parseFloat(a.amount), 0);
    expect(total).toBeCloseTo(25.33, 2);
    // each entry is a clean 2dp string
    for (const a of out) expect(a.amount).toMatch(/^\d+\.\d{2}$/);
  });
});
