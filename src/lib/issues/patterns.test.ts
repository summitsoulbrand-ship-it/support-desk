import { describe, it, expect } from 'vitest';
import { detectPatterns, type IssueRow } from './patterns';

const NOW = new Date('2026-09-07T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let seq = 0;
function row(over: Partial<IssueRow> = {}): IssueRow {
  seq += 1;
  return {
    threadId: `t${seq}`,
    customerEmail: `person${seq}@example.com`,
    customerName: `Person ${seq}`,
    category: 'PRINT_QUALITY',
    designName: null,
    problem: null,
    summary: 'a complaint',
    occurredAt: new Date(NOW.getTime() - HOUR),
    ...over,
  };
}

/** Enough history that the category spike test is switched on. */
const WARM = { now: NOW, historySpanDays: 30 };

describe('detectPatterns - design faults', () => {
  it('speaks once two different customers hit the same design', () => {
    const rows = [
      row({ designName: 'Frog Wizard Kerfuffle', problem: 'text not readable' }),
      row({ designName: 'Frog Wizard Kerfuffle', problem: 'cannot read the words' }),
    ];
    const [found] = detectPatterns(rows, WARM);
    expect(found.kind).toBe('design');
    expect(found.key).toBe('design:frog-wizard-kerfuffle');
    expect(found.customerCount).toBe(2);
    expect(found.detail).toContain('text not readable');
  });

  it('stays quiet for a single customer', () => {
    const rows = [row({ designName: 'Frog Wizard Kerfuffle', problem: 'faded' })];
    expect(detectPatterns(rows, WARM)).toEqual([]);
  });

  it('does not let one customer emailing twice look like two people', () => {
    const rows = [
      row({ designName: 'American Bison', customerEmail: 'sam@example.com' }),
      row({ designName: 'American Bison', customerEmail: 'SAM@example.com' }),
    ];
    expect(detectPatterns(rows, WARM)).toEqual([]);
  });

  it('ignores complaints that are not about the product itself', () => {
    // Two people whose parcels are late happen to own the same design. That
    // is the carrier, not the artwork.
    const rows = [
      row({ designName: 'American Bison', category: 'SHIPPING_DELAY' }),
      row({ designName: 'American Bison', category: 'SHIPPING_DELAY' }),
    ];
    expect(detectPatterns(rows, WARM).filter((p) => p.kind === 'design')).toEqual([]);
  });

  it('forgets complaints older than the design window', () => {
    const rows = [
      row({ designName: 'American Bison', occurredAt: new Date(NOW.getTime() - 40 * DAY) }),
      row({ designName: 'American Bison' }),
    ];
    expect(detectPatterns(rows, WARM)).toEqual([]);
  });

  it('counts a fault across sizing and print complaints on one design', () => {
    const rows = [
      row({ designName: 'Trail Dog', category: 'PRINT_QUALITY', problem: 'off center' }),
      row({ designName: 'Trail Dog', category: 'SIZING_FIT', problem: 'runs tiny' }),
    ];
    expect(detectPatterns(rows, WARM)[0]?.customerCount).toBe(2);
  });
});

describe('detectPatterns - category spikes', () => {
  /** n fresh complaints in the current window, each from a new customer. */
  const burst = (n: number, category: IssueRow['category']) =>
    Array.from({ length: n }, () =>
      row({ category, occurredAt: new Date(NOW.getTime() - HOUR) })
    );

  /** n older complaints spread across the baseline period. */
  const history = (n: number, category: IssueRow['category']) =>
    Array.from({ length: n }, (_, i) =>
      row({
        category,
        occurredAt: new Date(NOW.getTime() - (4 + i * 0.5) * DAY),
      })
    );

  it('flags a category running far above its own normal rate', () => {
    const rows = [...burst(6, 'NOT_DELIVERED'), ...history(4, 'NOT_DELIVERED')];
    const spike = detectPatterns(rows, WARM).find((p) => p.kind === 'category');
    expect(spike?.key).toBe('category:NOT_DELIVERED');
    expect(spike?.customerCount).toBe(6);
  });

  it('stays quiet when that volume is simply normal for the category', () => {
    // 6 now, but ~60 over the past month is the same rate - nothing changed.
    const rows = [...burst(6, 'SIZING_FIT'), ...history(60, 'SIZING_FIT')];
    expect(detectPatterns(rows, WARM).filter((p) => p.kind === 'category')).toEqual([]);
  });

  it('needs a floor of customers, not just a multiple of a tiny baseline', () => {
    const rows = [...burst(3, 'WEBSITE_CHECKOUT')];
    expect(detectPatterns(rows, WARM).filter((p) => p.kind === 'category')).toEqual([]);
  });

  it('holds its tongue until there is enough history to know what normal is', () => {
    const rows = burst(8, 'NOT_DELIVERED');
    const cold = detectPatterns(rows, { now: NOW, historySpanDays: 3 });
    expect(cold.filter((p) => p.kind === 'category')).toEqual([]);
  });

  it('never raises a spike over praise or pre-sale questions', () => {
    const rows = [...burst(20, 'PRAISE'), ...burst(20, 'PRODUCT_QUESTION')];
    expect(detectPatterns(rows, WARM).filter((p) => p.kind === 'category')).toEqual([]);
  });
});

describe('detectPatterns - ordering', () => {
  it('puts the pattern with the most customers first', () => {
    const rows = [
      row({ designName: 'Quiet Design' }),
      row({ designName: 'Quiet Design' }),
      row({ designName: 'Loud Design' }),
      row({ designName: 'Loud Design' }),
      row({ designName: 'Loud Design' }),
    ];
    const designs = detectPatterns(rows, WARM).filter((p) => p.kind === 'design');
    expect(designs.map((p) => p.customerCount)).toEqual([3, 2]);
    expect(designs[0].headline).toContain('Loud Design');
  });

  it('speaks up for something that never normally happens at all', () => {
    // Five people reporting broken checkout in a category with no history is
    // not a false alarm - it is the alarm working. A zero baseline means the
    // customer floor alone decides, which is why that floor is not two.
    const rows = Array.from({ length: 5 }, () =>
      row({ category: 'WEBSITE_CHECKOUT', occurredAt: new Date(NOW.getTime() - HOUR) })
    );
    const spike = detectPatterns(rows, WARM).find((p) => p.kind === 'category');
    expect(spike?.key).toBe('category:WEBSITE_CHECKOUT');
  });
});
