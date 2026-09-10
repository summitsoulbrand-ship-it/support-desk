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

  it('does not top up a fault count with size exchanges', () => {
    // This is how "Here Come the Shenanigans" alarmed: one genuine wrong-item
    // report plus one person wanting an XL. One real problem is not two.
    const rows = [
      row({ designName: 'Trail Dog', category: 'WRONG_ITEM', problem: 'sent short sleeve' }),
      row({ designName: 'Trail Dog', category: 'SIZING_FIT', problem: 'runs tiny' }),
    ];
    expect(detectPatterns(rows, WARM)).toEqual([]);
  });
});

describe('detectPatterns - size changes', () => {
  /** n size complaints on one design, each from a new customer, this window. */
  const sizes = (n: number, design: string, ageDays = 1) =>
    Array.from({ length: n }, () =>
      row({
        designName: design,
        category: 'SIZING_FIT',
        occurredAt: new Date(NOW.getTime() - ageDays * DAY),
      })
    );

  it('stays silent for two people wanting a different size', () => {
    // The "I Collect Rocks and I Know Things" alarm: two plain size swaps,
    // interrupting Pati for nothing.
    expect(detectPatterns(sizes(2, 'I Collect Rocks'), WARM)).toEqual([]);
  });

  it('stays silent at three, with no history to compare against', () => {
    expect(detectPatterns(sizes(3, 'Trail Dog'), WARM)).toEqual([]);
  });

  it('speaks when one design draws a lot of them', () => {
    const found = detectPatterns(sizes(4, 'Frog Wizard Kerfuffle'), WARM);
    expect(found).toHaveLength(1);
    expect(found[0].key).toBe('sizing:frog-wizard-kerfuffle');
    expect(found[0].headline).toContain('asked to change size');
  });

  it('speaks when a design suddenly draws double what it used to', () => {
    const rows = [
      ...sizes(3, 'Trail Dog', 1),
      ...sizes(1, 'Trail Dog', 20), // the window before
    ];
    const found = detectPatterns(rows, WARM);
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain('up from 1');
  });

  it('does not call a steady rate a jump', () => {
    const rows = [
      ...sizes(3, 'Trail Dog', 1),
      ...sizes(3, 'Trail Dog', 20),
    ];
    expect(detectPatterns(rows, WARM)).toEqual([]);
  });

  it('keeps size alerts separate from fault alerts on the same design', () => {
    const rows = [
      ...sizes(4, 'Frog Wizard Kerfuffle'),
      row({ designName: 'Frog Wizard Kerfuffle', category: 'PRINT_QUALITY', problem: 'frog has 5 legs' }),
      row({ designName: 'Frog Wizard Kerfuffle', category: 'PRINT_QUALITY', problem: 'five legs' }),
    ];
    const found = detectPatterns(rows, WARM);
    const fault = found.find((p) => p.key === 'design:frog-wizard-kerfuffle');
    const size = found.find((p) => p.key === 'sizing:frog-wizard-kerfuffle');
    expect(fault?.detail).toContain('frog has 5 legs');
    expect(fault?.customerCount).toBe(2);
    expect(size?.customerCount).toBe(4);
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
