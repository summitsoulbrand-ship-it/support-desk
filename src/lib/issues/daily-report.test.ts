import { describe, it, expect } from 'vitest';
import {
  attachUnits,
  categoryBreakdown,
  checkoutProblems,
  designWatchlist,
  kindsLine,
  needsEyes,
  printProblems,
  reportWindow,
} from './daily-report';
import type { IssueCategory, IssueSeverity } from '@prisma/client';

const NOW = new Date('2026-09-22T12:00:00Z');
/** When yesterday's report went out. */
const SINCE = new Date('2026-09-21T12:00:00Z');
const HOUR = 60 * 60 * 1000;
/** A row written before yesterday's report - she has seen it. */
const OLD = new Date(SINCE.getTime() - 5 * HOUR);
/** A row written after it - news today. */
const FRESH = new Date(SINCE.getTime() + 5 * HOUR);

let seq = 0;
type Row = Parameters<typeof designWatchlist>[0][number];
function row(over: Partial<Row> = {}): Row {
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
    occurredAt: FRESH,
    createdAt: FRESH,
    ...over,
  };
}
/** Three messages from one person, spaced an hour apart from `from`. */
function chaser(over: Partial<Row>, from: Date, count = 3): Row[] {
  const email = over.customerEmail || `chaser${++seq}@example.com`;
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(from.getTime() + i * HOUR);
    return row({ ...over, customerEmail: email, occurredAt: at, createdAt: at });
  });
}

describe('reportWindow', () => {
  it('is the last 24 hours when there has never been a report', () => {
    const w = reportWindow(NOW, null);
    expect(w.since).toEqual(new Date(NOW.getTime() - 24 * HOUR));
    expect(w.spanDays).toBe(1);
    expect(w.capped).toBe(false);
  });

  it("starts where yesterday's report stopped", () => {
    const w = reportWindow(NOW, SINCE);
    expect(w.since).toEqual(SINCE);
    expect(w.capped).toBe(false);
  });

  it('covers the gap after a missed report', () => {
    const w = reportWindow(NOW, new Date(NOW.getTime() - 50 * HOUR));
    expect(w.spanDays).toBeCloseTo(50 / 24, 5);
    expect(w.capped).toBe(false);
  });

  it('caps a long gap at three days rather than dumping a backlog', () => {
    const w = reportWindow(NOW, new Date(NOW.getTime() - 10 * 24 * HOUR));
    expect(w.spanDays).toBe(3);
    expect(w.capped).toBe(true);
  });
});

describe('designWatchlist', () => {
  it('lists a design once several customers complain, one line per person', () => {
    const rows = [
      row({ designName: 'Frog Wizard Kerfuffle', problem: 'text not readable' }),
      row({ designName: 'Frog Wizard Kerfuffle', problem: 'print cracked' }),
    ];
    const [found] = designWatchlist(rows, SINCE);
    expect(found.design).toBe('Frog Wizard Kerfuffle');
    expect(found.customers).toBe(2);
    expect(found.people.map((p) => p.problem)).toEqual(['text not readable', 'print cracked']);
    expect(found.threadIds).toEqual([rows[0].threadId, rows[1].threadId]);
  });

  it('is new on the list when it crossed the bar since the previous report', () => {
    const rows = [
      row({ designName: 'Surrender', problem: 'received wrong color', createdAt: OLD, occurredAt: OLD }),
      row({ designName: 'Surrender', problem: 'received wrong shirt' }),
    ];
    const [found] = designWatchlist(rows, SINCE);
    expect(found.isNew).toBe(true);
    expect(found.changed).toBe(true);
    expect(found.newCustomers).toBe(1);
    // The newcomer is marked; the earlier person is not, but is still spelled
    // out because the design itself was never on a list before.
    expect(found.people.map((p) => p.isNew)).toEqual([true, false]);
  });

  it('is unchanged when everyone on it was already in the previous report', () => {
    // The Sep 21 / Sep 22 case: identical lines two mornings running.
    const rows = [
      row({ designName: 'Wait, I see a rock', createdAt: OLD, occurredAt: OLD }),
      row({ designName: 'Wait, I see a rock', createdAt: OLD, occurredAt: OLD }),
    ];
    const [found] = designWatchlist(rows, SINCE);
    expect(found.isNew).toBe(false);
    expect(found.changed).toBe(false);
    expect(found.newCustomers).toBe(0);
  });

  it('is changed, not new, when an old design gains a customer', () => {
    // Fluffy Cow going from 2 customers on Sep 21 to 3 on Sep 22.
    const rows = [
      row({ designName: 'Fluffy Cow', createdAt: OLD, occurredAt: OLD }),
      row({ designName: 'Fluffy Cow', createdAt: OLD, occurredAt: OLD }),
      row({ designName: 'Fluffy Cow', problem: 'wrong designs added to order', category: 'WRONG_ITEM' }),
    ];
    const [found] = designWatchlist(rows, SINCE);
    expect(found.isNew).toBe(false);
    expect(found.changed).toBe(true);
    expect(found.newCustomers).toBe(1);
    expect(found.people[0]).toMatchObject({ isNew: true, problem: 'wrong designs added to order' });
  });

  it('shows one person who wrote three times as one line with their first words', () => {
    // Retired and Unsupervised, real: "lettering is not straight" / "Print not
    // straight" / "one shirt has crooked lettering" was one customer and read
    // as three problems.
    const rows = [
      ...chaser({ designName: 'Retired and Unsupervised', problem: 'lettering is not straight' }, FRESH).map(
        (r, i) => ({ ...r, problem: ['lettering is not straight', 'Print not straight', 'one shirt has crooked lettering'][i] })
      ),
      row({ designName: 'Retired and Unsupervised', problem: 'missing one shirt from order', category: 'WRONG_ITEM' }),
    ];
    const [found] = designWatchlist(rows, SINCE);
    expect(found.customers).toBe(2);
    expect(found.people).toHaveLength(2);
    const chased = found.people.find((p) => p.emails === 3);
    expect(chased?.problem).toBe('lettering is not straight');
  });

  it('treats the same address in different capitals as one customer', () => {
    const rows = [
      row({ designName: 'American Bison', customerEmail: 'sam@example.com' }),
      row({ designName: 'American Bison', customerEmail: 'SAM@example.com' }),
    ];
    expect(designWatchlist(rows, SINCE)).toEqual([]);
  });

  it('tells a wrong item shipped apart from a print or shirt fault', () => {
    const rows = [
      row({ designName: 'Surrender', category: 'WRONG_ITEM', problem: 'received wrong color' }),
      row({ designName: 'Surrender', category: 'PRINT_QUALITY', problem: 'print faded' }),
      row({ designName: 'Surrender', category: 'GARMENT_QUALITY', problem: 'hole in seam' }),
    ];
    const [found] = designWatchlist(rows, SINCE);
    expect(found.wrongItems).toBe(1);
    expect(found.faults).toBe(2);
    expect(found.people.find((p) => p.problem === 'received wrong color')?.kind).toBe('wrong-item');
    expect(kindsLine(found)).toBe(
      '2 with a print or shirt fault, 1 shipped the wrong item (packing, not the artwork)'
    );
  });

  it('leaves out a design only one person mentioned', () => {
    expect(designWatchlist([row({ designName: 'Lonely Design' })], SINCE)).toEqual([]);
  });

  it('leaves out complaints the design cannot be blamed for', () => {
    const rows = [
      row({ designName: 'American Bison', category: 'NOT_DELIVERED' }),
      row({ designName: 'American Bison', category: 'SHIPPING_DELAY' }),
    ];
    expect(designWatchlist(rows, SINCE)).toEqual([]);
  });

  it('leaves size exchanges out of the fault list entirely', () => {
    // 22 of the first 24 attributed issues were size swaps. Left in, they
    // filled this list and buried the one design that was really broken.
    const rows = [
      row({ designName: 'I Collect Rocks', category: 'SIZING_FIT', problem: 'too large' }),
      row({ designName: 'I Collect Rocks', category: 'SIZING_FIT', problem: 'needs bigger' }),
      row({ designName: 'I Collect Rocks', category: 'SIZING_FIT', problem: 'too small' }),
    ];
    expect(designWatchlist(rows, SINCE)).toEqual([]);
  });

  it('still lists a genuine fault on a design that also draws size swaps', () => {
    const rows = [
      row({ designName: 'Frog Wizard Kerfuffle', category: 'SIZING_FIT', problem: 'too small' }),
      row({ designName: 'Frog Wizard Kerfuffle', category: 'PRINT_QUALITY', problem: 'frog has 5 legs' }),
      row({ designName: 'Frog Wizard Kerfuffle', category: 'PRINT_QUALITY', problem: 'five legs' }),
    ];
    const [found] = designWatchlist(rows, SINCE);
    expect(found.customers).toBe(2);
    expect(found.people.map((p) => p.problem)).toEqual(['frog has 5 legs', 'five legs']);
  });

  it('puts what changed first, then the most-complained-about design', () => {
    const rows = [
      row({ designName: 'Two New' }),
      row({ designName: 'Two New' }),
      row({ designName: 'Three Old', createdAt: OLD, occurredAt: OLD }),
      row({ designName: 'Three Old', createdAt: OLD, occurredAt: OLD }),
      row({ designName: 'Three Old', createdAt: OLD, occurredAt: OLD }),
      row({ designName: 'Three Grew', createdAt: OLD, occurredAt: OLD }),
      row({ designName: 'Three Grew', createdAt: OLD, occurredAt: OLD }),
      row({ designName: 'Three Grew' }),
    ];
    expect(designWatchlist(rows, SINCE).map((d) => d.design)).toEqual([
      'Three Grew',
      'Two New',
      'Three Old',
    ]);
  });
});

describe('attachUnits', () => {
  it('puts the units ordered beside the design, ignoring case and punctuation', () => {
    const list = designWatchlist(
      [row({ designName: 'Wait, I see a rock' }), row({ designName: 'Wait, I see a rock' })],
      SINCE
    );
    attachUnits(list, new Map([['Wait, I See A Rock', 170]]));
    expect(list[0].units).toBe(170);
  });

  it('never guesses from a partial match', () => {
    // "Retired" must not be handed the units of "Retired and Unsupervised".
    const list = designWatchlist([row({ designName: 'Retired' }), row({ designName: 'Retired' })], SINCE);
    attachUnits(list, new Map([['Retired and Unsupervised', 100]]));
    expect(list[0].units).toBeNull();
  });
});

describe('needsEyes', () => {
  const high = (over: Partial<Row> = {}) =>
    row({ severity: 'HIGH', category: 'WRONG_ITEM', ...over });

  it('shows one person once however many times they wrote, with the count', () => {
    // Barbara Hastings, Sep 22: three bullets for one wrong shirt.
    const theirs = chaser({ severity: 'HIGH', category: 'WRONG_ITEM', designName: 'Surrender' }, FRESH).map(
      (r, i) => ({ ...r, summary: `email ${i + 1}` })
    );
    const found = needsEyes(theirs, theirs, SINCE);
    expect(found).toHaveLength(1);
    expect(found[0].summary).toBe('email 3');
    expect(found[0].emails).toBe(3);
    expect(found[0].design).toBe('Surrender');
  });

  it('counts earlier messages from the same person that were already reported', () => {
    const earlier = row({ customerEmail: 'kaye@example.com', category: 'PRINT_QUALITY', createdAt: OLD, occurredAt: OLD });
    const today = high({ customerEmail: 'kaye@example.com', category: 'PRINT_QUALITY' });
    const [found] = needsEyes([today], [earlier, today], SINCE);
    expect(found.emails).toBe(2);
    expect(found.isPrint).toBe(true);
  });

  it('marks someone who was already in a report and wrote again', () => {
    const before = high({ customerEmail: 'mike@example.com', createdAt: OLD, occurredAt: OLD });
    const again = high({ customerEmail: 'mike@example.com' });
    const [found] = needsEyes([again], [before, again], SINCE);
    expect(found.status).toBe('chased');
    expect(found.emails).toBe(2);
    // Someone whose only urgent message is today is simply new.
    expect(needsEyes([high()], [], SINCE)[0].status).toBe('new');
  });

  it('never lists a size exchange, however upset', () => {
    expect(needsEyes([high({ category: 'SIZING_FIT' })], [], SINCE)).toEqual([]);
  });

  it('puts the newest message first', () => {
    const a = high({ occurredAt: new Date(FRESH.getTime() + HOUR) });
    const b = high({ occurredAt: new Date(FRESH.getTime() + 2 * HOUR) });
    expect(needsEyes([a, b], [a, b], SINCE).map((e) => e.threadId)).toEqual([b.threadId, a.threadId]);
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
    const [found] = printProblems(rows, SINCE);
    expect(found.problem).toBe('text blends into blue shirt, not readable');
    expect(found.detail).toBe('The cream lettering barely shows against the blue shirt.');
    expect(found.design).toBeNull();
    expect(found.status).toBe('new');
  });

  it('does not repeat someone already reported who has been quiet since', () => {
    const rows = [row({ category: 'PRINT_QUALITY', createdAt: OLD, occurredAt: OLD })];
    expect(printProblems(rows, SINCE)).toEqual([]);
  });

  it('brings someone back only when they wrote again, marked as such', () => {
    const rows = chaser({ category: 'PRINT_QUALITY', problem: 'print peeling' }, OLD, 2);
    // First message before yesterday's report, second after it.
    rows[1].createdAt = FRESH;
    rows[1].occurredAt = FRESH;
    const [found] = printProblems(rows, SINCE);
    expect(found.status).toBe('chased');
    expect(found.emails).toBe(2);
  });

  it('is one entry per person, taking the message that carries the detail', () => {
    const rows = chaser({ category: 'PRINT_QUALITY', problem: 'print cracked' }, FRESH, 2);
    rows[1].detail = 'Cracked across the frog after one wash.';
    const found = printProblems(rows, SINCE);
    expect(found).toHaveLength(1);
    expect(found[0].detail).toBe('Cracked across the frog after one wash.');
  });

  it('puts an angry customer at the top', () => {
    const rows = [
      row({ category: 'PRINT_QUALITY', problem: 'slightly off center', severity: 'MEDIUM' }),
      row({ category: 'PRINT_QUALITY', problem: 'print cracked after one wash', severity: 'HIGH' }),
    ];
    expect(printProblems(rows, SINCE).map((r) => r.problem)).toEqual([
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
    expect(printProblems(rows, SINCE)).toEqual([]);
  });

  it('still names the design when there is one', () => {
    const rows = [
      row({ category: 'PRINT_QUALITY', designName: 'Frog Wizard Kerfuffle', problem: 'frog has 5 legs' }),
    ];
    expect(printProblems(rows, SINCE)[0].design).toBe('Frog Wizard Kerfuffle');
  });
});

describe('checkoutProblems', () => {
  const blocked = (over: Partial<Row> = {}) =>
    row({ category: 'WEBSITE_CHECKOUT', blockedPurchase: true, ...over });

  it('speaks once a second customer cannot check out', () => {
    // Measured shape, 2026-09-11: three people hit one payment-method bug in a
    // day and the report said "Website or checkout: 5".
    const rows = [
      blocked({ problem: 'could not change payment method', detail: 'Checkout would not let her switch cards.' }),
      blocked({ problem: 'could not change payment method' }),
    ];
    const found = checkoutProblems(rows, SINCE);
    expect(found.customers).toBe(2);
    expect(found.items).toHaveLength(2);
    expect(found.items[0].detail).toBeTruthy();
    expect(found.items.every((i) => i.status === 'new')).toBe(true);
  });

  it('says nothing about a single person', () => {
    expect(checkoutProblems([blocked()], SINCE).items).toEqual([]);
  });

  it('counts people, not messages, and lists each once', () => {
    // Forrest Glass and Laura Abraham, Sep 21: two entries each for one failure.
    const rows = [
      ...chaser({ category: 'WEBSITE_CHECKOUT', blockedPurchase: true, customerEmail: 'sam@example.com', problem: 'charged but no confirmation' }, FRESH, 2),
      blocked({ customerEmail: 'SAM@example.com' }),
      ...chaser({ category: 'WEBSITE_CHECKOUT', blockedPurchase: true, customerEmail: 'laura@example.com' }, FRESH, 2),
    ];
    const found = checkoutProblems(rows, SINCE);
    expect(found.customers).toBe(2);
    expect(found.items).toHaveLength(2);
    expect(found.items.find((i) => i.emails === 3)?.problem).toBe('charged but no confirmation');
  });

  it('marks everyone new the first time the bar is crossed, even the earlier person', () => {
    const rows = [
      blocked({ createdAt: OLD, occurredAt: OLD }),
      blocked(),
    ];
    expect(checkoutProblems(rows, SINCE).items.map((i) => i.status)).toEqual(['new', 'new']);
  });

  it('tells apart who is new, who wrote again, and who has been quiet', () => {
    const quiet = blocked({ createdAt: OLD, occurredAt: OLD });
    const again = chaser({ category: 'WEBSITE_CHECKOUT', blockedPurchase: true }, OLD, 2);
    again[1].createdAt = FRESH;
    again[1].occurredAt = FRESH;
    const fresh = blocked();
    const found = checkoutProblems([quiet, ...again, fresh], SINCE);
    expect(found.items.map((i) => i.status)).toEqual(['new', 'chased', 'quiet']);
  });

  it('ignores people who were only asking about a code', () => {
    // 32 discount-code messages in 30 days, most of them questions. Without
    // this the list is mostly "is there a sale on?".
    const rows = [
      row({ category: 'DISCOUNT_CODE', blockedPurchase: false, summary: 'asks if a sale is on' }),
      row({ category: 'DISCOUNT_CODE', blockedPurchase: false, summary: 'asks how to use a credit' }),
      row({ category: 'DISCOUNT_CODE', blockedPurchase: null, summary: 'written before the flag existed' }),
    ];
    expect(checkoutProblems(rows, SINCE).items).toEqual([]);
  });

  it('counts a rejected code alongside a broken checkout', () => {
    const rows = [
      blocked({ problem: 'cart would not submit' }),
      row({ category: 'DISCOUNT_CODE', blockedPurchase: true, problem: 'store credit rejected' }),
    ];
    expect(checkoutProblems(rows, SINCE).customers).toBe(2);
  });

  it('leaves out a blocked sale that is not about paying us', () => {
    const rows = [
      row({ category: 'NOT_DELIVERED', blockedPurchase: true }),
      row({ category: 'PRINT_QUALITY', blockedPurchase: true }),
    ];
    expect(checkoutProblems(rows, SINCE).items).toEqual([]);
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
