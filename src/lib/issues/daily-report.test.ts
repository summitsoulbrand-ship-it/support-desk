import { describe, it, expect } from 'vitest';
import {
  designWatchlist,
  categoryBreakdown,
  printProblems,
  checkoutProblems,
} from './daily-report';
import type { IssueCategory, IssueSeverity } from '@prisma/client';

const NOW = new Date('2026-09-07T12:00:00Z');

let seq = 0;
function row(over: Partial<Parameters<typeof designWatchlist>[0][number]> = {}) {
  seq += 1;
  return {
    threadId: `t${seq}`,
    customerEmail: `person${seq}@example.com`,
    customerName: `Person ${seq}`,
    category: 'PRINT_QUALITY' as IssueCategory,
    severity: 'MEDIUM' as IssueSeverity,
    designName: null,
    problem: null,
    summary: 'a complaint',
    detail: null,
    blockedPurchase: null,
    occurredAt: NOW,
    ...over,
  };
}

describe('designWatchlist', () => {
  it('lists a design once several customers complain, with their words', () => {
    const rows = [
      row({ designName: 'Frog Wizard Kerfuffle', problem: 'text not readable' }),
      row({ designName: 'Frog Wizard Kerfuffle', problem: 'print cracked' }),
    ];
    expect(designWatchlist(rows)).toEqual([
      {
        design: 'Frog Wizard Kerfuffle',
        customers: 2,
        problems: ['text not readable', 'print cracked'],
        threadIds: [rows[0].threadId, rows[1].threadId],
      },
    ]);
  });

  it('does not repeat a problem two customers worded identically', () => {
    const rows = [
      row({ designName: 'American Bison', problem: 'text not readable' }),
      row({ designName: 'American Bison', problem: 'text not readable' }),
    ];
    expect(designWatchlist(rows)[0].problems).toEqual(['text not readable']);
  });

  it('leaves out a design only one person mentioned', () => {
    expect(designWatchlist([row({ designName: 'Lonely Design' })])).toEqual([]);
  });

  it('leaves out complaints the design cannot be blamed for', () => {
    const rows = [
      row({ designName: 'American Bison', category: 'NOT_DELIVERED' }),
      row({ designName: 'American Bison', category: 'SHIPPING_DELAY' }),
    ];
    expect(designWatchlist(rows)).toEqual([]);
  });

  it('leaves size exchanges out of the fault list entirely', () => {
    // 22 of the first 24 attributed issues were size swaps. Left in, they
    // filled this list and buried the one design that was really broken.
    const rows = [
      row({ designName: 'I Collect Rocks', category: 'SIZING_FIT', problem: 'too large' }),
      row({ designName: 'I Collect Rocks', category: 'SIZING_FIT', problem: 'needs bigger' }),
      row({ designName: 'I Collect Rocks', category: 'SIZING_FIT', problem: 'too small' }),
    ];
    expect(designWatchlist(rows)).toEqual([]);
  });

  it('still lists a genuine fault on a design that also draws size swaps', () => {
    const rows = [
      row({ designName: 'Frog Wizard Kerfuffle', category: 'SIZING_FIT', problem: 'too small' }),
      row({ designName: 'Frog Wizard Kerfuffle', category: 'PRINT_QUALITY', problem: 'frog has 5 legs' }),
      row({ designName: 'Frog Wizard Kerfuffle', category: 'PRINT_QUALITY', problem: 'five legs' }),
    ];
    const [found] = designWatchlist(rows);
    expect(found.customers).toBe(2);
    expect(found.problems).toEqual(['frog has 5 legs', 'five legs']);
  });

  it('puts the most-complained-about design at the top', () => {
    const rows = [
      row({ designName: 'Two People' }),
      row({ designName: 'Two People' }),
      row({ designName: 'Three People' }),
      row({ designName: 'Three People' }),
      row({ designName: 'Three People' }),
    ];
    expect(designWatchlist(rows).map((d) => d.design)).toEqual([
      'Three People',
      'Two People',
    ]);
  });
});

describe('categoryBreakdown', () => {
  it('shows today beside the recent daily average', () => {
    const today = [row({ category: 'SHIPPING_DELAY' }), row({ category: 'SHIPPING_DELAY' })];
    // 14 over the 7 baseline days = 2 a day, so today is exactly normal.
    const baseline = Array.from({ length: 14 }, () => row({ category: 'SHIPPING_DELAY' }));
    expect(categoryBreakdown(today, baseline)).toEqual([
      { category: 'SHIPPING_DELAY', count: 2, average: 2 },
    ]);
  });

  it('reports an average of zero for something that has never come up before', () => {
    const today = [row({ category: 'WEBSITE_CHECKOUT' })];
    expect(categoryBreakdown(today, [])).toEqual([
      { category: 'WEBSITE_CHECKOUT', count: 1, average: 0 },
    ]);
  });

  it('lists the serious categories before the harmless ones', () => {
    const today = [
      row({ category: 'PRAISE' }),
      row({ category: 'PRINT_QUALITY' }),
      row({ category: 'PRODUCT_QUESTION' }),
      row({ category: 'NOT_DELIVERED' }),
    ];
    expect(categoryBreakdown(today, []).map((b) => b.category)).toEqual([
      'PRINT_QUALITY',
      'NOT_DELIVERED',
      'PRODUCT_QUESTION',
      'PRAISE',
    ]);
  });

  it('leaves out categories nobody wrote about today', () => {
    const today = [row({ category: 'PRAISE' })];
    const baseline = [row({ category: 'SHIPPING_DELAY' })];
    expect(categoryBreakdown(today, baseline).map((b) => b.category)).toEqual(['PRAISE']);
  });
});

describe('printProblems', () => {
  it('lists a print complaint nobody else reported, with its detail', () => {
    // The case that started this (2026-09-14, real): one customer, MEDIUM, no
    // design attached, so it appeared in the report as nothing but "+1" in a
    // count column. It is a garment color to stop pairing with that ink.
    const rows = [
      row({
        category: 'PRINT_QUALITY',
        problem: 'text blends into blue shirt, not readable',
        detail: 'The cream lettering barely shows against the blue shirt.',
      }),
    ];
    const [found] = printProblems(rows);
    expect(found.problem).toBe('text blends into blue shirt, not readable');
    expect(found.detail).toBe('The cream lettering barely shows against the blue shirt.');
    expect(found.design).toBeNull();
  });

  it('puts an angry customer at the top', () => {
    const rows = [
      row({ category: 'PRINT_QUALITY', problem: 'slightly off center', severity: 'MEDIUM' }),
      row({ category: 'PRINT_QUALITY', problem: 'print cracked after one wash', severity: 'HIGH' }),
    ];
    expect(printProblems(rows).map((r) => r.problem)).toEqual([
      'print cracked after one wash',
      'slightly off center',
    ]);
  });

  it('leaves out everything that is not about the printing', () => {
    const rows = [
      row({ category: 'SIZING_FIT' }),
      row({ category: 'GARMENT_QUALITY' }),
      row({ category: 'NOT_DELIVERED' }),
      row({ category: 'PRAISE' }),
    ];
    expect(printProblems(rows)).toEqual([]);
  });

  it('still names the design when there is one', () => {
    const rows = [
      row({ category: 'PRINT_QUALITY', designName: 'Frog Wizard Kerfuffle', problem: 'frog has 5 legs' }),
    ];
    expect(printProblems(rows)[0].design).toBe('Frog Wizard Kerfuffle');
  });
});

describe('checkoutProblems', () => {
  const blocked = (over = {}) =>
    row({ category: 'WEBSITE_CHECKOUT', blockedPurchase: true, ...over });

  it('speaks once a second customer cannot check out', () => {
    // Measured shape, 2026-09-11: three people hit one payment-method bug in a
    // day and the report said "Website or checkout: 5".
    const rows = [
      blocked({ problem: 'could not change payment method', detail: 'Checkout would not let her switch cards.' }),
      blocked({ problem: 'could not change payment method' }),
    ];
    const found = checkoutProblems(rows);
    expect(found.customers).toBe(2);
    expect(found.items).toHaveLength(2);
    expect(found.items[0].detail).toBeTruthy();
  });

  it('says nothing about a single person', () => {
    expect(checkoutProblems([blocked()]).items).toEqual([]);
  });

  it('counts people, not messages', () => {
    const rows = [
      blocked({ customerEmail: 'sam@example.com' }),
      blocked({ customerEmail: 'SAM@example.com' }),
      blocked({ customerEmail: 'sam@example.com' }),
    ];
    expect(checkoutProblems(rows).items).toEqual([]);
  });

  it('ignores people who were only asking about a code', () => {
    // 32 discount-code messages in 30 days, most of them questions. Without
    // this the list is mostly "is there a sale on?".
    const rows = [
      row({ category: 'DISCOUNT_CODE', blockedPurchase: false, summary: 'asks if a sale is on' }),
      row({ category: 'DISCOUNT_CODE', blockedPurchase: false, summary: 'asks how to use a credit' }),
      row({ category: 'DISCOUNT_CODE', blockedPurchase: null, summary: 'written before the flag existed' }),
    ];
    expect(checkoutProblems(rows).items).toEqual([]);
  });

  it('counts a rejected code alongside a broken checkout', () => {
    const rows = [
      blocked({ problem: 'cart would not submit' }),
      row({ category: 'DISCOUNT_CODE', blockedPurchase: true, problem: 'store credit rejected' }),
    ];
    expect(checkoutProblems(rows).customers).toBe(2);
  });

  it('leaves out a blocked sale that is not about paying us', () => {
    const rows = [
      row({ category: 'NOT_DELIVERED', blockedPurchase: true }),
      row({ category: 'PRINT_QUALITY', blockedPurchase: true }),
    ];
    expect(checkoutProblems(rows).items).toEqual([]);
  });
});
