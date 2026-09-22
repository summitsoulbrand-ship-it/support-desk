/**
 * The daily customer report - what came in since the previous report, what is
 * worth her attention, and which designs are getting complained about.
 *
 * It always sends, even on a quiet day. This report exists because the daily
 * one stopped arriving, and silence is exactly the failure it replaces: an
 * empty inbox and a broken job look identical when nothing shows up. A day
 * with nothing in it says so in one line.
 *
 * THE REPORT IS A DIFF, NOT A STATE DUMP (Pati, 2026-09-22: "it is always
 * repeating the same issues and just adding new ones to the same design").
 * Three things caused that, and each is handled here:
 *
 *  - Nothing remembered what the previous report said. The design list was
 *    rebuilt every morning from a rolling 14-day window, so a design stayed on
 *    it for 14 days after its last complaint, word for word (Sep 21 and Sep 22
 *    carried identical lines). Now the boundary is the previous report's send
 *    time - the DAILY_REPORT claim row the worker writes - and a design is
 *    spelled out only when it is new to the list or gained a customer since
 *    then. Everything still open from earlier days is one muted line.
 *
 *  - Every section listed MESSAGES, not people. One customer chasing three
 *    times appeared three times in "needs your eyes" and added three
 *    differently worded phrases to a design's line, and a phrase that differed
 *    only by a capital letter was listed twice. Everything is grouped by
 *    customer now: one line each, their earliest phrase (the first message is
 *    the complaint; later ones restate it), and "(3 emails)" when they chased.
 *
 *  - The 2-customer bar ignored volume, so the list was the bestseller list:
 *    on 2026-09-22 the five designs on it were the #1, #2, #4, #5 and #7
 *    sellers of the same 14 days. The bar is unchanged, but each design shows
 *    how many units were ordered in the window beside the count, and a wrong
 *    item shipped (a packing error) is labeled apart from a print or shirt
 *    fault (the artwork or the blank).
 *
 * THREE SECTIONS ADDED THE SAME DAY (Pati, 2026-09-22, "do all"):
 *
 *  - WRONG PARCELS, grouped by what went wrong across every design. A wrong
 *    color, a wrong design and a missing shirt all landed as "wrong item"
 *    under whichever design was ordered, so one Printify packing problem read
 *    as four separate design problems. Six in one day against 1.4 normally;
 *    two checked against their Shopify orders had the right order and the
 *    wrong parcel. This is a number to take to Printify, so it carries the
 *    14-day split by kind and how many designs each kind touched.
 *
 *  - REVIEWS of three stars or fewer, in their words. The Slack copy already
 *    counted them; the email never saw them, and a review is product feedback
 *    that never reaches the inbox. Read BEFORE the email now, under a time
 *    cap - past the cap the section says they could not be read and the
 *    report goes out anyway, so a slow Judge.me still cannot delay or lose it.
 *
 *  - SHIRT faults join print faults in the in-their-words section. A hole, a
 *    tight neck or shrinking used to be a "+1" in a count unless a second
 *    customer hit the same design; and any fault whose customer's order held
 *    several designs (about 40% of them when this was built) was invisible
 *    because it could not be attributed. Listed once now, design or not.
 *
 * "Since the previous report" is judged on when the desk WROTE the row
 * (created_at), not when the customer wrote in (occurred_at): the analysis
 * runs on a 48-hour window and can read a message late, and a row that was
 * not in yesterday's report is news today whenever the customer sent it.
 *
 * Structure follows how Pati reads: the headline first, then only the things
 * that need her, then the counts. Categories carry their own recent average
 * beside them, because "6 shipping complaints" means nothing without knowing
 * whether 6 is a normal Tuesday.
 *
 * CHECKOUT and PAYMENT failures print in full once more than one person hits
 * them (Pati, 2026-09-16). Nobody writes in about a broken checkout; they
 * leave. So two strangers bothering to write is already a lot of lost orders.
 *
 * The Slack copy carries the social-comment count the email does not (Pati,
 * 2026-09-16). The report is still built from EMAIL plus the reviews section -
 * nothing from social is classified, attributed to a design, or fed to the
 * pattern alarm. See channels.ts.
 *
 * Size changes per design are GONE (Pati, 2026-09-16): a size exchange is
 * ordinary trade on a unisex tee. Sizing still appears in the day's counts.
 */

import { IssueCategory, IssueSeverity } from '@prisma/client';
import prisma from '@/lib/db';
import { createOutboundEmailSender } from '@/lib/email';
import { postToIssueReport } from '@/lib/slack';
import {
  channelLines,
  reviewCounts,
  socialCounts,
  type ReviewCounts,
} from '@/lib/issues/channels';
import { unitsOrderedByDesign } from '@/lib/issues/design-lookup';
import {
  WRONG_ITEM_KIND_LABEL,
  isWrongItemKind,
  wrongItemKindFromText,
  type WrongItemKind,
} from '@/lib/issues/wrong-parcels';
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  SEVERITY_RANK,
  isCheckout,
  isDefect,
  isProblem,
} from '@/lib/issues/categories';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Days the "normal for this" average is measured over. */
const BASELINE_DAYS = 7;
/** How far back the design watchlist looks. */
const DESIGN_WINDOW_DAYS = parseInt(
  process.env.ISSUE_DESIGN_WINDOW_DAYS || '14',
  10
);
/** Complaints on one design before it makes the watchlist. */
const DESIGN_WATCH_MIN = parseInt(process.env.ISSUE_DESIGN_ALERT_MIN || '2', 10);
/**
 * How far back the checkout list looks. 48 hours, not 24, so a pair of
 * customers straddling midnight still reads as a pair - and it matches the
 * window the spike alarm uses, so the two never disagree about what "right
 * now" means.
 */
const CHECKOUT_WINDOW_HOURS = parseInt(
  process.env.ISSUE_CHECKOUT_WINDOW_HOURS || '48',
  10
);
/** Distinct customers blocked at checkout before the section appears at all. */
const CHECKOUT_MIN_CUSTOMERS = parseInt(
  process.env.ISSUE_CHECKOUT_REPORT_MIN || '2',
  10
);
/**
 * The most one report will cover when the previous one is further back than a
 * day (worker down, sends failing). Three days of mail is still readable; ten
 * is a wall, and past that a fresh start is more use than a backlog.
 */
const MAX_REPORT_SPAN_DAYS = 3;
/**
 * A DAILY_REPORT claim younger than this is the run in progress, not the
 * previous report - the worker claims the day moments before calling here.
 */
const CLAIM_SETTLE_MS = 30 * 60 * 1000;
/**
 * Longest the report waits for Judge.me before sending without it. The
 * reviews used to be read after the email precisely so a slow API could not
 * hold the report; now that the email prints them, the cap does that job.
 */
const REVIEW_READ_TIMEOUT_MS = parseInt(
  process.env.ISSUE_REVIEW_TIMEOUT_MS || '20000',
  10
);
/** Stars at or below which a review is printed. Mirrors channels.ts. */
const LOW_STAR = 3;

function esc(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface DailyReportStats {
  total: number;
  problems: number;
  highSeverity: number;
  /** Designs spelled out today: new to the list or with a new customer. */
  designsWatched: number;
  /** Every design on the list, including the ones only on the muted line. */
  designsOpen: number;
  /** Print and shirt faults spelled out today. */
  faultProblems: number;
  /** Distinct customers with a wrong parcel since the previous report. */
  wrongParcels: number;
  /** Distinct customers a checkout or payment failure stopped, 0 below the floor. */
  checkoutBlocked: number;
  /** Null when the channel could not be read - never confuse that with none. */
  socialComments: number | null;
  reviews: number | null;
  lowStarReviews: number | null;
  sent: boolean;
}

interface Row {
  threadId: string;
  customerEmail: string;
  customerName: string | null;
  category: IssueCategory;
  severity: IssueSeverity;
  designName: string | null;
  problem: string | null;
  summary: string;
  detail: string | null;
  wrongItemKind: string | null;
  blockedPurchase: boolean | null;
  /** When the customer wrote. */
  occurredAt: Date;
  /** When the desk read it into a row - what "since the previous report" is judged on. */
  createdAt: Date;
}

const SELECT = {
  threadId: true,
  customerEmail: true,
  customerName: true,
  category: true,
  severity: true,
  designName: true,
  problem: true,
  summary: true,
  detail: true,
  wrongItemKind: true,
  blockedPurchase: true,
  occurredAt: true,
  createdAt: true,
} as const;

// --- People, not messages -------------------------------------------------

/** One person is one email address, however they capitalized it that day. */
const personKey = (r: Pick<Row, 'customerEmail'>) => r.customerEmail.toLowerCase();
const oldestFirst = (a: Row, b: Row) => a.occurredAt.getTime() - b.occurredAt.getTime();
const nameOf = (r: Row) => r.customerName || r.customerEmail;
const unique = <T>(xs: T[]) => Array.from(new Set(xs));

/** Rows per person, each person's rows oldest first. Insertion order = first appearance. */
function groupByPerson(rows: Row[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const r of rows) {
    const k = personKey(r);
    const list = out.get(k) || [];
    list.push(r);
    out.set(k, list);
  }
  for (const list of out.values()) list.sort(oldestFirst);
  return out;
}

const firstWritten = (rows: Row[]) => Math.min(...rows.map((r) => r.createdAt.getTime()));
const lastWritten = (rows: Row[]) => Math.max(...rows.map((r) => r.createdAt.getTime()));

/**
 * Where a person stands against the previous report: NEW when nothing of
 * theirs existed when it went out, CHASED when they were in it and have
 * written again since, QUIET when she has already seen everything they sent.
 */
export type PersonStatus = 'new' | 'chased' | 'quiet';

function statusSince(rows: Row[], since: Date): PersonStatus {
  const s = since.getTime();
  if (firstWritten(rows) > s) return 'new';
  if (lastWritten(rows) > s) return 'chased';
  return 'quiet';
}

const STATUS_RANK: Record<PersonStatus, number> = { new: 2, chased: 1, quiet: 0 };

/**
 * Their own words for the problem: the EARLIEST phrase. The first message is
 * the complaint; the chasers restate it, and the model rewords each one
 * ("lettering is not straight" / "Print not straight" / "one shirt has
 * crooked lettering" was one person), which is exactly the pile-up this
 * replaces. Rows must be oldest first.
 */
function phraseOf(rows: Row[]): string | null {
  return rows.find((r) => r.problem)?.problem ?? null;
}

// --- The window ------------------------------------------------------------

export interface ReportWindow {
  /** Rows written after this are news. */
  since: Date;
  /** Days the window spans: 1 on an ordinary day, more after a missed report. */
  spanDays: number;
  /** The previous report was further back than the cap, so older mail is skipped. */
  capped: boolean;
}

/**
 * What "since the previous report" means today. Pure so the cap is testable.
 * With no previous report at all (first run) it is the last 24 hours.
 */
export function reportWindow(now: Date, previousReportAt: Date | null): ReportWindow {
  const floor = now.getTime() - MAX_REPORT_SPAN_DAYS * DAY_MS;
  const prev = previousReportAt ? previousReportAt.getTime() : now.getTime() - DAY_MS;
  const since = new Date(Math.min(Math.max(prev, floor), now.getTime()));
  return {
    since,
    spanDays: (now.getTime() - since.getTime()) / DAY_MS,
    capped: prev < floor,
  };
}

/**
 * When the previous report went out - the youngest DAILY_REPORT claim that is
 * not today's and has had time to settle. Null when there is none, or the
 * table cannot be read; the window then falls back to 24 hours rather than
 * the report failing.
 */
async function previousReportAt(now: Date, todayKey: string | null): Promise<Date | null> {
  try {
    const recent = await prisma.issueAlert.findMany({
      where: { kind: 'DAILY_REPORT' },
      orderBy: { firstSentAt: 'desc' },
      take: 5,
      select: { key: true, firstSentAt: true },
    });
    const prior = recent.find(
      (r) =>
        r.key !== todayKey && r.firstSentAt.getTime() <= now.getTime() - CLAIM_SETTLE_MS
    );
    return prior?.firstSentAt ?? null;
  } catch (err) {
    console.error('[issue-report] could not read the previous report time:', err);
    return null;
  }
}

/**
 * A read that must never hold the report: past the cap it resolves to null,
 * which every section prints as "could not read", and the slow call is left
 * to finish on its own.
 */
function withTimeout<T>(p: Promise<T | null>, ms: number, label: string): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error(`[issue-report] ${label} took longer than ${ms}ms - reporting it as unread`);
      resolve(null);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        console.error(`[issue-report] ${label} failed:`, err);
        resolve(null);
      }
    );
  });
}

// --- Designs ---------------------------------------------------------------

/** A print or shirt fault is the artwork or the blank; a wrong item is packing. */
export type FaultKind = 'fault' | 'wrong-item';

export interface WatchedPerson {
  who: string;
  problem: string | null;
  kind: FaultKind;
  /** Messages from this person about this design in the window. */
  emails: number;
  /** Nothing from them existed when the previous report went out. */
  isNew: boolean;
  threadId: string;
}

export interface WatchedDesign {
  design: string;
  /** Distinct customers in the window. */
  customers: number;
  newCustomers: number;
  /** Crossed the bar since the previous report - it was not on the last list. */
  isNew: boolean;
  /** Worth spelling out today: new to the list, or a customer joined. */
  changed: boolean;
  faults: number;
  wrongItems: number;
  people: WatchedPerson[];
  threadIds: string[];
  /** Units of this design ordered in the window, null when unknown. */
  units: number | null;
}

/**
 * Designs with several people reporting a FAULT, one line per person.
 *
 * Size exchanges are not faults and stay out - mixing them in buried a frog
 * printed with five legs underneath four people wanting a bigger shirt.
 * `since` decides what is news: a design is `changed` when it crossed the bar
 * after the previous report, or when a customer joined it since. Changed
 * designs sort first, then by how many people are on them.
 */
export function designWatchlist(
  rows: Row[],
  since: Date,
  minCustomers = DESIGN_WATCH_MIN
): WatchedDesign[] {
  const byDesign = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.designName || !isDefect(r.category)) continue;
    const list = byDesign.get(r.designName) || [];
    list.push(r);
    byDesign.set(r.designName, list);
  }

  const s = since.getTime();
  const out: WatchedDesign[] = [];
  for (const [design, group] of byDesign) {
    const persons = groupByPerson(group);
    if (persons.size < minCustomers) continue;

    let seenBefore = 0;
    const people: WatchedPerson[] = [];
    for (const theirs of persons.values()) {
      const isNew = firstWritten(theirs) > s;
      if (!isNew) seenBefore += 1;
      const newest = theirs[theirs.length - 1];
      people.push({
        who: nameOf(newest),
        problem: phraseOf(theirs),
        kind: theirs.every((r) => r.category === 'WRONG_ITEM') ? 'wrong-item' : 'fault',
        emails: theirs.length,
        isNew,
        threadId: newest.threadId,
      });
    }
    people.sort((a, b) => Number(b.isNew) - Number(a.isNew));

    const newCustomers = people.filter((p) => p.isNew).length;
    // Fewer than the bar had been seen when the last report went out, so the
    // design was not on that list - every person on it is news, not only the
    // one who tipped it over.
    const isNew = seenBefore < minCustomers;
    out.push({
      design,
      customers: people.length,
      newCustomers,
      isNew,
      changed: isNew || newCustomers > 0,
      faults: people.filter((p) => p.kind === 'fault').length,
      wrongItems: people.filter((p) => p.kind === 'wrong-item').length,
      people,
      threadIds: unique(group.map((g) => g.threadId)),
      units: null,
    });
  }

  return out.sort(
    (a, b) => Number(b.changed) - Number(a.changed) || b.customers - a.customers
  );
}

const normTitle = (t: string) =>
  t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Put the units-ordered figure beside each design. Exact match on the reduced
 * title only, case and punctuation aside: a looser match would hand "Retired"
 * the units of "Retired and Unsupervised", and a wrong denominator is worse
 * than none. A design with no match keeps null and the line omits the figure.
 */
export function attachUnits(
  list: WatchedDesign[],
  units: Map<string, number>
): WatchedDesign[] {
  const byKey = new Map<string, number>();
  for (const [title, n] of units) {
    const k = normTitle(title);
    if (k) byKey.set(k, (byKey.get(k) || 0) + n);
  }
  for (const d of list) {
    const n = byKey.get(normTitle(d.design));
    d.units = n === undefined ? null : n;
  }
  return list;
}

// --- Needs your eyes -------------------------------------------------------

export interface EyesItem {
  who: string;
  summary: string;
  design: string | null;
  /** Problem messages from this person in the whole window, so a chaser shows as one. */
  emails: number;
  /** A print or shirt fault - spelled out again in the section below. */
  isFault: boolean;
  /** NEW, or CHASED when they were already in a previous report and wrote again. */
  status: PersonStatus;
  threadId: string;
  occurredAt: Date;
}

const isUrgent = (r: Row) =>
  isProblem(r.category) && r.severity === 'HIGH' && r.category !== 'SIZING_FIT';

const isFault = (r: Row) =>
  r.category === 'PRINT_QUALITY' || r.category === 'GARMENT_QUALITY';

/**
 * HIGH-severity problems written since the previous report, one line per
 * person with their newest message. A size exchange is never a single-shirt
 * emergency, however upset the customer sounded (Pati, 2026-09-10).
 */
export function needsEyes(fresh: Row[], pool: Row[], since: Date): EyesItem[] {
  const everyone = groupByPerson(pool.filter((r) => isProblem(r.category)));
  const urgentBefore = groupByPerson(pool.filter(isUrgent));
  return Array.from(groupByPerson(fresh.filter(isUrgent)).entries())
    .map(([key, theirs]) => {
      const newest = theirs[theirs.length - 1];
      return {
        who: nameOf(newest),
        summary: newest.summary,
        design: [...theirs].reverse().find((r) => r.designName)?.designName ?? null,
        emails: (everyone.get(key) || theirs).length,
        isFault: theirs.some(isFault),
        status: statusSince(urgentBefore.get(key) || theirs, since),
        threadId: newest.threadId,
        occurredAt: newest.occurredAt,
      };
    })
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
}

// --- Print and shirt problems ----------------------------------------------

export interface FaultItem {
  who: string;
  design: string | null;
  /** Which part failed: the printing, or the blank shirt itself. */
  kind: 'print' | 'shirt';
  problem: string | null;
  detail: string | null;
  summary: string;
  severity: IssueSeverity;
  emails: number;
  status: PersonStatus;
  threadId: string;
  /** When they last wrote. */
  occurredAt: Date;
}

/**
 * Every print or shirt complaint in the window, in full, one entry per person
 * - and only people with something new: NEW since the previous report, or
 * CHASED (already reported, wrote again). Anyone she has read about and who
 * has been quiet since is left out rather than repeated.
 *
 * Deliberately NOT gated on two customers saying the same thing, and NOT on
 * the design being known. A fault is rare, and one person is usually enough:
 * "text blends into blue shirt" is a garment color to stop offering, "neck
 * too tight" is a blank to question. Designs with several customers still get
 * their own watchlist above; this list carries the words.
 */
export function faultProblems(pool: Row[], since: Date): FaultItem[] {
  return Array.from(groupByPerson(pool.filter(isFault)).values())
    .map((theirs) => {
      const status = statusSince(theirs, since);
      const told = theirs.find((r) => r.detail) ?? theirs[0];
      const newest = theirs[theirs.length - 1];
      const worst = theirs.reduce((a, b) =>
        SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a
      );
      return {
        who: nameOf(newest),
        design: theirs.find((r) => r.designName)?.designName ?? null,
        kind: theirs.some((r) => r.category === 'PRINT_QUALITY')
          ? ('print' as const)
          : ('shirt' as const),
        problem: phraseOf(theirs),
        detail: told.detail,
        summary: told.summary,
        severity: worst.severity,
        emails: theirs.length,
        status,
        threadId: newest.threadId,
        occurredAt: newest.occurredAt,
      };
    })
    .filter((p) => p.status !== 'quiet')
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        b.occurredAt.getTime() - a.occurredAt.getTime()
    );
}

// --- Wrong parcels ---------------------------------------------------------

export interface WrongParcel {
  who: string;
  kind: WrongItemKind;
  /** The design they ordered, when known. */
  design: string | null;
  problem: string | null;
  detail: string | null;
  summary: string;
  emails: number;
  status: PersonStatus;
  threadId: string;
  occurredAt: Date;
}

export interface WrongParcelKind {
  kind: WrongItemKind;
  /** Distinct customers in the window. */
  customers: number;
  /** Distinct designs it hit - the same kind on many designs is a packing problem, not a design one. */
  designs: number;
}

export interface WrongParcelReport {
  /** People with something new: NEW since the previous report or CHASED. */
  items: WrongParcel[];
  /** Distinct customers with a wrong parcel written since the previous report. */
  freshCustomers: number;
  /** The whole window split by what went wrong, biggest first. */
  byKind: WrongParcelKind[];
  /** Distinct customers in the whole window. */
  customers: number;
  /** Wrong-parcel messages per day over the baseline. */
  average: number;
}

/** The kind for one person: the classifier's when a row has one, else read from the words. */
function parcelKind(rows: Row[]): WrongItemKind {
  const tagged = rows.find((r) => isWrongItemKind(r.wrongItemKind));
  if (tagged && isWrongItemKind(tagged.wrongItemKind)) return tagged.wrongItemKind;
  const first = rows[0];
  return wrongItemKindFromText(first.problem, first.detail, first.summary);
}

/**
 * Wrong parcels across every design, grouped by what went wrong. Per person,
 * like everything else: one entry, the earliest words, status against the
 * previous report. The by-kind split covers the whole window so the number
 * she takes to Printify is two weeks of evidence, not one morning's.
 */
export function wrongParcels(
  pool: Row[],
  baseline: Row[],
  since: Date,
  baselineDays = BASELINE_DAYS
): WrongParcelReport {
  const persons = groupByPerson(pool.filter((r) => r.category === 'WRONG_ITEM'));

  const all = Array.from(persons.values()).map((theirs) => {
    const first = theirs[0];
    const newest = theirs[theirs.length - 1];
    return {
      who: nameOf(newest),
      kind: parcelKind(theirs),
      design: theirs.find((r) => r.designName)?.designName ?? null,
      problem: phraseOf(theirs),
      detail: theirs.find((r) => r.detail)?.detail ?? null,
      summary: first.summary,
      emails: theirs.length,
      status: statusSince(theirs, since),
      threadId: newest.threadId,
      occurredAt: newest.occurredAt,
    };
  });

  const kinds = new Map<WrongItemKind, { customers: number; designs: Set<string> }>();
  for (const p of all) {
    const k = kinds.get(p.kind) || { customers: 0, designs: new Set<string>() };
    k.customers += 1;
    if (p.design) k.designs.add(p.design);
    kinds.set(p.kind, k);
  }

  const baselineCount = baseline.filter((r) => r.category === 'WRONG_ITEM').length;

  return {
    items: all
      .filter((p) => p.status !== 'quiet')
      .sort(
        (a, b) =>
          STATUS_RANK[b.status] - STATUS_RANK[a.status] ||
          b.occurredAt.getTime() - a.occurredAt.getTime()
      ),
    freshCustomers: all.filter((p) => p.status === 'new').length,
    byKind: Array.from(kinds.entries())
      .map(([kind, k]) => ({ kind, customers: k.customers, designs: k.designs.size }))
      .sort((a, b) => b.customers - a.customers),
    customers: all.length,
    average: baselineDays > 0 ? baselineCount / baselineDays : 0,
  };
}

// --- Checkout --------------------------------------------------------------

export interface CheckoutItem {
  who: string;
  problem: string | null;
  detail: string | null;
  summary: string;
  category: IssueCategory;
  emails: number;
  status: PersonStatus;
  threadId: string;
  /** When they last wrote. */
  occurredAt: Date;
}

/**
 * Checkout, payment and code failures - only the ones that actually stopped
 * a sale, and only once more than one person has hit them.
 *
 * Both halves matter. Without `blockedPurchase` the list fills with people
 * asking whether a sale is on: of 32 discount-code messages in 30 days, most
 * were questions. And a lone "my code would not apply" is a support ticket,
 * not news for the owner - it becomes news at two people, because for every
 * customer who writes in about a checkout that will not submit, many simply
 * close the tab.
 *
 * One entry per person, oldest message's words (that is the failure; the
 * rest are chasers). When the bar is crossed for the first time since the
 * previous report nobody on the list has been shown yet, so everyone is NEW.
 * Returns an empty list below the floor, so the section disappears entirely
 * rather than showing a one.
 */
export function checkoutProblems(
  rows: Row[],
  since: Date,
  minCustomers = CHECKOUT_MIN_CUSTOMERS
): { customers: number; items: CheckoutItem[] } {
  const blocked = rows.filter(
    (r) => isCheckout(r.category) && r.blockedPurchase === true
  );
  const persons = groupByPerson(blocked);
  const customers = persons.size;
  if (customers < minCustomers) return { customers, items: [] };

  const s = since.getTime();
  const seenBefore = Array.from(persons.values()).filter(
    (theirs) => firstWritten(theirs) <= s
  ).length;
  const crossed = seenBefore < minCustomers;

  const items = Array.from(persons.values())
    .map((theirs) => {
      const first = theirs[0];
      const newest = theirs[theirs.length - 1];
      return {
        who: nameOf(newest),
        problem: first.problem,
        detail: first.detail,
        summary: first.summary,
        category: first.category,
        emails: theirs.length,
        status: crossed ? ('new' as PersonStatus) : statusSince(theirs, since),
        threadId: newest.threadId,
        occurredAt: newest.occurredAt,
      };
    })
    .sort(
      (a, b) =>
        STATUS_RANK[b.status] - STATUS_RANK[a.status] ||
        b.occurredAt.getTime() - a.occurredAt.getTime()
    );

  return { customers, items };
}

// --- Counts ----------------------------------------------------------------

/** Category counts for the window, each with its recent daily average. */
export function categoryBreakdown(
  today: Row[],
  baseline: Row[],
  baselineDays = BASELINE_DAYS
): { category: IssueCategory; count: number; average: number }[] {
  const count = new Map<IssueCategory, number>();
  for (const r of today) count.set(r.category, (count.get(r.category) || 0) + 1);

  const priorCount = new Map<IssueCategory, number>();
  for (const r of baseline) {
    priorCount.set(r.category, (priorCount.get(r.category) || 0) + 1);
  }

  return CATEGORY_ORDER.filter((c) => count.has(c)).map((category) => ({
    category,
    count: count.get(category) || 0,
    average: baselineDays > 0 ? (priorCount.get(category) || 0) / baselineDays : 0,
  }));
}

// --- Rendering helpers -----------------------------------------------------

const NEW_TAG = `<span style="color:#9a3412;font-size:11px;font-weight:bold">NEW</span>`;
const AGAIN_TAG = `<span style="color:#9a3412;font-size:11px;font-weight:bold">WROTE AGAIN</span>`;
const muted = (t: string) => `<span style="color:#999;font-size:12px">${t}</span>`;
const mutedLine = (t: string) => `<p style="margin:4px 0 18px;color:#999;font-size:12px">${t}</p>`;

const emailsNote = (n: number) => (n > 1 ? ` ${muted(`(${n} emails)`)}` : '');

/** "2 with a print or shirt fault, 1 shipped the wrong item (packing, not the artwork)". */
export function kindsLine(d: Pick<WatchedDesign, 'faults' | 'wrongItems'>): string {
  const parts: string[] = [];
  if (d.faults) parts.push(`${d.faults} with a print or shirt fault`);
  if (d.wrongItems) {
    parts.push(`${d.wrongItems} shipped the wrong item (packing, not the artwork)`);
  }
  return parts.join(', ');
}

/** "wrong color 6 on 4 designs, wrong design 3 on 3 designs, shirt missing 2". */
export function parcelKindsLine(byKind: WrongParcelKind[]): string {
  return byKind
    .map(
      (k) =>
        `${WRONG_ITEM_KIND_LABEL[k.kind]} ${k.customers}` +
        (k.designs > 1 ? ` on ${k.designs} designs` : '')
    )
    .join(', ');
}

const personProblem = (p: WatchedPerson) =>
  p.problem || (p.kind === 'wrong-item' ? 'wrong item shipped' : 'fault reported');

const stars = (n: number) => `${n} ${n === 1 ? 'star' : 'stars'}`;

// --- The report ------------------------------------------------------------

export async function sendDailyIssueReport(
  now = new Date(),
  opts: { todayKey?: string } = {}
): Promise<DailyReportStats> {
  const window = reportWindow(now, await previousReportAt(now, opts.todayKey ?? null));
  const { since } = window;
  const baselineStart = new Date(since.getTime() - BASELINE_DAYS * DAY_MS);
  const poolStart = new Date(now.getTime() - DESIGN_WINDOW_DAYS * DAY_MS);
  const checkoutStart = new Date(now.getTime() - CHECKOUT_WINDOW_HOURS * HOUR_MS);

  const [pool, baseline, units, reviews] = await Promise.all([
    prisma.customerIssue.findMany({
      where: { occurredAt: { gte: poolStart, lte: now } },
      select: SELECT,
      orderBy: { occurredAt: 'desc' },
    }),
    prisma.customerIssue.findMany({
      where: { createdAt: { gte: baselineStart, lt: since } },
      select: SELECT,
    }),
    unitsOrderedByDesign(DESIGN_WINDOW_DAYS),
    // Read before the email because the email prints them - but never allowed
    // to hold it. Past the cap the section says they could not be read.
    withTimeout<ReviewCounts>(reviewCounts(now, since), REVIEW_READ_TIMEOUT_MS, 'reviews'),
  ]);

  // News = written since the previous report. Judged on the row's write time,
  // not the message time - see the header.
  const fresh = pool.filter(
    (r) => r.createdAt.getTime() > since.getTime() && r.createdAt.getTime() <= now.getTime()
  );
  const problems = fresh.filter((r) => isProblem(r.category));
  const eyes = needsEyes(fresh, pool, since);
  const watchlist = attachUnits(designWatchlist(pool, since), units);
  const changed = watchlist.filter((d) => d.changed);
  const unchanged = watchlist.filter((d) => !d.changed);
  const faults = faultProblems(pool, since);
  const parcels = wrongParcels(pool, baseline, since);
  const checkout = checkoutProblems(
    pool.filter((r) => r.occurredAt.getTime() >= checkoutStart.getTime()),
    since
  );
  const loud = checkout.items.filter((i) => i.status !== 'quiet');
  const quiet = checkout.items.filter((i) => i.status === 'quiet');
  const breakdown = categoryBreakdown(fresh, baseline);
  const lowStars = reviews?.lowStars ?? [];

  const base = process.env.NEXTAUTH_URL || 'https://selfservice.summitsoul.shop';
  const to =
    process.env.ISSUE_REPORT_EMAIL_TO ||
    process.env.EVAL_EMAIL_TO ||
    'summitsoulbrand@gmail.com';

  const dateLabel = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
  const sinceLabel =
    window.spanDays < 1.5
      ? `yesterday's report`
      : `the previous report, ${Math.round(window.spanDays)} days ago`;
  const open = (threadId: string) =>
    `<a href="${base}/inbox?thread=${threadId}" style="font-size:12px">open</a>`;

  // --- Email ---
  let html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px">`;
  html += `<h2 style="margin-bottom:2px">Customer report - ${esc(dateLabel)}</h2>`;
  html +=
    `<p style="margin:0 0 18px;color:#555">` +
    (fresh.length === 0
      ? `No customer emails since ${sinceLabel}.`
      : `${fresh.length} customer ${fresh.length === 1 ? 'email' : 'emails'} ` +
        `since ${sinceLabel}. ${problems.length} reported a problem.`) +
    `</p>`;
  if (window.capped) {
    html += mutedLine(
      `The previous report was more than ${MAX_REPORT_SPAN_DAYS} days ago, so this ` +
        `one covers the last ${MAX_REPORT_SPAN_DAYS} days only.`
    );
  }

  if (eyes.length > 0) {
    html +=
      `<h3 style="margin-bottom:4px;color:#9a3412">Needs your eyes (${eyes.length})</h3>` +
      `<ul style="margin:4px 0 18px;padding-left:20px">`;
    for (const e of eyes) {
      html +=
        `<li style="margin:6px 0">` +
        (e.status === 'chased' ? `${AGAIN_TAG} ` : '') +
        `<b>${esc(e.who)}</b> - ${esc(e.summary)}` +
        (e.design ? ` <span style="color:#777">(${esc(e.design)})</span>` : '') +
        emailsNote(e.emails) +
        // An angry fault belongs in both lists - this one for triage, the one
        // below for what to change - so say it is the same person rather than
        // letting it read as two complaints.
        (e.isFault ? ` ${muted('(detail below)')}` : '') +
        ` ${open(e.threadId)}</li>`;
    }
    html += `</ul>`;
  }

  if (watchlist.length > 0) {
    html +=
      `<h3 style="margin-bottom:4px">Designs to look at` +
      (changed.length
        ? ` (${changed.length} ${changed.length === 1 ? 'change' : 'changes'})`
        : ` (nothing new)`) +
      `</h3>` +
      `<p style="margin:0 0 6px;color:#777;font-size:12px">` +
      `Same design, several different customers, last ${DESIGN_WINDOW_DAYS} days. ` +
      `Spelled out only when something changed since the previous report; ` +
      `the rest is one line below. A wrong item shipped is a packing error, ` +
      `not the artwork - see "Wrong parcels" for those across every design.</p>`;
    if (changed.length) {
      html += `<ul style="margin:4px 0 8px;padding-left:20px">`;
      for (const d of changed) {
        html +=
          `<li style="margin:8px 0"><b>${esc(d.design)}</b> ` +
          (d.isNew
            ? `${NEW_TAG} ${muted('on the list')}`
            : `${NEW_TAG} ${muted(`${d.newCustomers} more ${d.newCustomers === 1 ? 'customer' : 'customers'}`)}`) +
          ` - ${d.customers} customers` +
          (d.units !== null
            ? ` of about ${d.units} ordered in the last ${DESIGN_WINDOW_DAYS} days`
            : '') +
          `: ${esc(kindsLine(d))}` +
          `<ul style="margin:4px 0 0;padding-left:18px">`;
        for (const p of d.people) {
          html +=
            `<li style="margin:3px 0">` +
            (p.isNew ? `${NEW_TAG} ` : '') +
            `${esc(p.who)} - ${esc(personProblem(p))}` +
            (p.kind === 'wrong-item' && p.problem ? ` ${muted('(wrong item)')}` : '') +
            emailsNote(p.emails) +
            ` ${open(p.threadId)}</li>`;
        }
        html += `</ul></li>`;
      }
      html += `</ul>`;
    }
    if (unchanged.length) {
      html += mutedLine(
        `Still on the list from earlier days, nothing new: ` +
          esc(
            unchanged
              .map(
                (d) =>
                  `${d.design} (${d.customers}` +
                  (d.units !== null ? ` of about ${d.units} ordered` : '') +
                  `)`
              )
              .join(', ')
          )
      );
    } else {
      html += `<div style="height:10px"></div>`;
    }
  }

  if (faults.length > 0) {
    html +=
      `<h3 style="margin-bottom:4px">Print and shirt problems (${faults.length})</h3>` +
      `<p style="margin:0 0 6px;color:#777;font-size:12px">` +
      `Everything customers said about the printing or the shirt itself, in ` +
      `their words, listed once - with or without a design named. Someone ` +
      `already reported comes back only if they wrote again.</p>` +
      `<ul style="margin:4px 0 18px;padding-left:20px">`;
    for (const r of faults) {
      html +=
        `<li style="margin:8px 0">` +
        (r.status === 'chased' ? `${AGAIN_TAG} ` : '') +
        `<b>${esc(r.problem || r.summary)}</b>` +
        ` ${muted(r.kind === 'print' ? 'print' : 'shirt')}` +
        (r.design
          ? ` <span style="color:#777">on ${esc(r.design)}</span>`
          : ` <span style="color:#999">(design not named)</span>`) +
        (r.detail ? `<br><span style="color:#444">${esc(r.detail)}</span>` : '') +
        `<br><span style="color:#999;font-size:12px">${esc(r.who)}` +
        (r.severity === 'HIGH' ? ` - upset` : '') +
        (r.emails > 1 ? ` (${r.emails} emails)` : '') +
        ` <a href="${base}/inbox?thread=${r.threadId}">open</a></span></li>`;
    }
    html += `</ul>`;
  }

  if (parcels.customers > 0) {
    const windowLine =
      `Last ${DESIGN_WINDOW_DAYS} days: ${esc(parcelKindsLine(parcels.byKind))} - ` +
      `${parcels.customers} ${parcels.customers === 1 ? 'customer' : 'customers'} in all, ` +
      `normally ${parcels.average.toFixed(1)} a day.`;
    if (parcels.items.length > 0) {
      html +=
        `<h3 style="margin-bottom:4px">Wrong parcels (${parcels.freshCustomers} new)</h3>` +
        `<p style="margin:0 0 6px;color:#777;font-size:12px">` +
        `What arrived was not what was ordered - a packing error at Printify, ` +
        `not the artwork. Grouped by what went wrong across every design, ` +
        `because one packing problem shows up on many designs and a per-design ` +
        `list hides it.</p>` +
        `<p style="margin:0 0 6px;font-size:14px">${windowLine}</p>` +
        `<ul style="margin:4px 0 18px;padding-left:20px">`;
      for (const p of parcels.items) {
        html +=
          `<li style="margin:8px 0">` +
          (p.status === 'chased' ? `${AGAIN_TAG} ` : `${NEW_TAG} `) +
          `<b>${esc(WRONG_ITEM_KIND_LABEL[p.kind])}</b>` +
          (p.design ? ` <span style="color:#777">- ordered ${esc(p.design)}</span>` : '') +
          `<br><span style="color:#444">${esc(p.detail || p.problem || p.summary)}</span>` +
          `<br><span style="color:#999;font-size:12px">${esc(p.who)}` +
          (p.emails > 1 ? ` (${p.emails} emails)` : '') +
          ` <a href="${base}/inbox?thread=${p.threadId}">open</a></span></li>`;
      }
      html += `</ul>`;
    } else {
      html += mutedLine(`Wrong parcels: nothing new since ${sinceLabel}. ${windowLine}`);
    }
  }

  if (loud.length > 0) {
    html +=
      `<h3 style="margin-bottom:4px;color:#9a3412">` +
      `People who could not buy (${checkout.customers})</h3>` +
      `<p style="margin:0 0 6px;color:#777;font-size:12px">` +
      `${checkout.customers} different customers hit a checkout, payment or ` +
      `code failure in the last ${CHECKOUT_WINDOW_HOURS} hours. Only messages ` +
      `where something actually stopped the sale are here - questions about ` +
      `codes are not. For everyone who writes in, more just close the tab.</p>` +
      `<ul style="margin:4px 0 8px;padding-left:20px">`;
    for (const r of loud) {
      html +=
        `<li style="margin:8px 0">` +
        (r.status === 'chased' ? `${AGAIN_TAG} ` : '') +
        `<b>${esc(r.problem || r.summary)}</b>` +
        `<br><span style="color:#444">${esc(r.detail || r.summary)}</span>` +
        `<br><span style="color:#999;font-size:12px">${esc(r.who)} - ` +
        `${esc(CATEGORY_LABEL[r.category])}` +
        (r.emails > 1 ? ` (${r.emails} emails)` : '') +
        ` <a href="${base}/inbox?thread=${r.threadId}">open</a></span></li>`;
    }
    html += `</ul>`;
    if (quiet.length) {
      html += mutedLine(
        `Also inside the ${CHECKOUT_WINDOW_HOURS} hours, already reported: ` +
          `${esc(quiet.map((q) => q.who).join(', '))}`
      );
    } else {
      html += `<div style="height:10px"></div>`;
    }
  } else if (quiet.length > 0) {
    html += mutedLine(
      `Checkout: ${checkout.customers} people still inside the ` +
        `${CHECKOUT_WINDOW_HOURS}-hour window, nothing new from them: ` +
        `${esc(quiet.map((q) => q.who).join(', '))}`
    );
  }

  // Reviews: the low-star ones in full, and one line either way, so a channel
  // that could not be read never looks like a channel with nothing in it.
  if (!reviews) {
    html += mutedLine(`Reviews: could not be read today.`);
  } else if (lowStars.length > 0) {
    html +=
      `<h3 style="margin-bottom:4px">Reviews of ${LOW_STAR} stars or fewer (${lowStars.length})</h3>` +
      `<p style="margin:0 0 6px;color:#777;font-size:12px">` +
      `Left on Judge.me since ${sinceLabel}, in their words - product feedback ` +
      `that never reaches the inbox. ${reviews.total}${reviews.capped ? '+' : ''} ` +
      `reviews came in all told, ${reviews.avgRating.toFixed(1)} stars average.</p>` +
      `<ul style="margin:4px 0 18px;padding-left:20px">`;
    for (const r of lowStars) {
      html +=
        `<li style="margin:8px 0"><b>${stars(r.rating)}</b>` +
        (r.product ? ` <span style="color:#777">on ${esc(r.product)}</span>` : '') +
        (r.title ? ` - <b>${esc(r.title)}</b>` : '') +
        (r.body ? `<br><span style="color:#444">${esc(r.body)}</span>` : '') +
        `<br><span style="color:#999;font-size:12px">${esc(r.reviewer || 'Customer')}</span></li>`;
    }
    html += `</ul>`;
  } else {
    html += mutedLine(
      reviews.total === 0
        ? `Reviews: none since ${sinceLabel}.`
        : `Reviews: ${reviews.total}${reviews.capped ? '+' : ''} since ${sinceLabel}, ` +
            `${reviews.avgRating.toFixed(1)} stars average, none at ${LOW_STAR} stars or below.`
    );
  }

  if (breakdown.length > 0) {
    html +=
      `<h3 style="margin-bottom:4px">What people wrote about</h3>` +
      `<table style="border-collapse:collapse;font-size:14px;margin:4px 0 18px">`;
    for (const b of breakdown) {
      const avg = b.average.toFixed(1);
      // The window can span more than a day after a missed report, so the
      // count is judged against that many days of the average.
      const hot = b.count > b.average * window.spanDays * 1.5 && b.count >= 3;
      html +=
        `<tr>` +
        `<td style="padding:3px 14px 3px 0">${esc(CATEGORY_LABEL[b.category])}</td>` +
        `<td style="padding:3px 14px 3px 0;text-align:right"><b>${b.count}</b></td>` +
        `<td style="padding:3px 0;color:${hot ? '#9a3412' : '#999'};font-size:12px">` +
        `normally ${avg}/day${hot ? ' - running high' : ''}</td>` +
        `</tr>`;
    }
    html += `</table>`;
  }

  html +=
    `<p style="color:#999;font-size:11px;margin-top:20px">` +
    `Built from the support inbox plus Judge.me reviews - social comments are ` +
    `not in here. Everything is per customer, not per email, and only what ` +
    `changed since the previous report is spelled out. A design is only named ` +
    `when the customer said which one or their order had just the one. Size ` +
    `changes are counted above and nothing more - they are ordinary trade on ` +
    `a unisex tee.</p>` +
    `</div>`;

  let sent = false;
  try {
    const sender = await createOutboundEmailSender();
    if (sender) {
      const subject =
        fresh.length === 0 && lowStars.length === 0
          ? `Customer report: a quiet day`
          : `Customer report: ${problems.length} problems` +
            (eyes.length ? `, ${eyes.length} need you` : '') +
            (changed.length
              ? `, ${changed.length} ${changed.length === 1 ? 'design' : 'designs'} to check`
              : '') +
            (parcels.freshCustomers
              ? `, ${parcels.freshCustomers} wrong ${parcels.freshCustomers === 1 ? 'parcel' : 'parcels'}`
              : '') +
            (lowStars.length
              ? `, ${lowStars.length} low ${lowStars.length === 1 ? 'review' : 'reviews'}`
              : '') +
            // Loud in the subject line, because it is the one thing here that
            // is costing money right now rather than describing yesterday.
            (loud.length ? `, ${checkout.customers} could not check out` : '');
      await sender.sendMessage({
        to: [{ address: to }],
        fromName: 'Summit Soul Desk',
        subject,
        bodyHtml: html,
      });
      sent = true;
    }
  } catch (err) {
    console.error('[issue-report] email failed:', err);
  }

  // --- Social comments, for Slack only ---
  //
  // Read AFTER the email is sent, and never allowed to throw. Returns null
  // rather than zero when it cannot read, and the line says so.
  const social = await socialCounts(now);

  // --- Slack: the headline only, so the channel stays scannable ---
  // This goes to the DAILY REPORTS channel, never to escalations (Pati,
  // 2026-09-10). With no daily-reports webhook set it simply posts nowhere -
  // the email still arrives. Posts every day, including a quiet one, for the
  // same reason the email does.
  {
    const lines = [
      `*Customer report - ${dateLabel}*`,
      `${fresh.length} emails, ${problems.length} problems, ${eyes.length} need you.`,
      ...channelLines(social, reviews),
    ];
    if (loud.length) {
      lines.push(
        `:rotating_light: ${checkout.customers} customers could not check out ` +
          `in ${CHECKOUT_WINDOW_HOURS}h - ${loud[0].problem || loud[0].summary}`
      );
    }
    for (const d of changed.slice(0, 5)) {
      lines.push(
        `• ${d.design}: ${d.customers} customers` +
          (d.isNew ? ' (new on the list)' : ` (${d.newCustomers} new)`) +
          (d.units !== null ? ` of ~${d.units} ordered` : '') +
          ` - ` +
          d.people
            .slice(0, 3)
            .map((p) => `${p.who}: ${personProblem(p)}`)
            .join('; ')
      );
    }
    if (unchanged.length) {
      lines.push(
        `• Still open, nothing new: ` +
          unchanged.map((d) => `${d.design} (${d.customers})`).join(', ')
      );
    }
    for (const r of faults.slice(0, 3)) {
      lines.push(
        `• ${r.kind === 'print' ? 'Print' : 'Shirt'}${r.status === 'chased' ? ' (wrote again)' : ''}: ` +
          `${r.problem || r.summary}${r.design ? ` (${r.design})` : ''}`
      );
    }
    if (parcels.freshCustomers) {
      lines.push(
        `• Wrong parcels: ${parcels.freshCustomers} new - ` +
          `${DESIGN_WINDOW_DAYS} days: ${parcelKindsLine(parcels.byKind)}`
      );
    }
    for (const r of lowStars.slice(0, 3)) {
      lines.push(
        `• Review ${r.rating}★${r.product ? ` on ${r.product}` : ''}: ` +
          `${(r.title || r.body).slice(0, 120)}`
      );
    }
    await postToIssueReport(lines.join('\n'));
  }

  return {
    total: fresh.length,
    problems: problems.length,
    highSeverity: eyes.length,
    designsWatched: changed.length,
    designsOpen: watchlist.length,
    faultProblems: faults.length,
    wrongParcels: parcels.freshCustomers,
    checkoutBlocked: loud.length ? checkout.customers : 0,
    socialComments: social?.comments ?? null,
    reviews: reviews?.total ?? null,
    lowStarReviews: reviews ? lowStars.length : null,
    sent,
  };
}
