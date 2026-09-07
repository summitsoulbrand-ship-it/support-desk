import { describe, it, expect } from 'vitest';
import { designWatchlist, categoryBreakdown } from './daily-report';
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
