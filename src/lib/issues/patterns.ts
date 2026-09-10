/**
 * The alarm: several customers reporting the same thing, said the moment it is
 * visible rather than in tomorrow's report.
 *
 * Two shapes of pattern, because they need different evidence:
 *
 *  - A DESIGN fault. Two different people reporting a product problem on the
 *    same artwork is already a signal, because the bucket is narrow: of every
 *    design in the catalog, of every kind of complaint, two strangers landed
 *    on the same one. Reprints are expensive and a bad print file keeps
 *    shipping until someone stops it, so this one speaks early.
 *
 *  - A CATEGORY spike. "Lots of shipping complaints" needs more than a count,
 *    because some volume is simply normal for an apparel store. So a category
 *    has to clear a floor of distinct customers AND run at twice its own
 *    recent rate, and the test stays switched off until there is enough
 *    history to know what normal looks like. A first week of alarms would
 *    teach Pati to ignore the alarm.
 *
 * Nothing here fires twice for the same pattern: an alert speaks again only
 * once the count has climbed further, so a problem that is spreading gets a
 * second ping and a problem sitting still stays quiet.
 */

import { IssueCategory } from '@prisma/client';
import prisma from '@/lib/db';
import { createOutboundEmailSender } from '@/lib/email';
import { postToIssueAlert } from '@/lib/slack';
import { CATEGORY_LABEL, isDefect, isProblem } from '@/lib/issues/categories';

/** Distinct customers on one design before it is worth interrupting for. */
const DESIGN_MIN_CUSTOMERS = parseInt(
  process.env.ISSUE_DESIGN_ALERT_MIN || '2',
  10
);
/**
 * Sizing runs on its own, much higher bar (Pati, 2026-09-10: "only the overall
 * trend per product or in case it changes or is high"). Two people wanting a
 * different size is a normal week on a unisex tee, so it takes either a high
 * count on one design, or a real jump against that design's own last window.
 */
const SIZING_MIN_CUSTOMERS = parseInt(
  process.env.ISSUE_SIZING_ALERT_MIN || '4',
  10
);
/** A jump this many times the design's previous window also counts as news. */
const SIZING_JUMP_MULTIPLE = 2;
/** ...but never off one extra person. */
const SIZING_JUMP_FLOOR = 3;
const DESIGN_WINDOW_DAYS = parseInt(
  process.env.ISSUE_DESIGN_WINDOW_DAYS || '14',
  10
);
/** Distinct customers in one category, inside the spike window. */
const CATEGORY_MIN_CUSTOMERS = parseInt(
  process.env.ISSUE_CATEGORY_ALERT_MIN || '5',
  10
);
const CATEGORY_WINDOW_HOURS = parseInt(
  process.env.ISSUE_CATEGORY_WINDOW_HOURS || '48',
  10
);
/** How far above its own recent rate a category has to run. */
const SPIKE_MULTIPLE = 2;
/** Days of history the baseline is measured over, and the minimum to use it. */
const BASELINE_DAYS = 30;
const MIN_BASELINE_DAYS = 7;
/** Extra customers needed before an already-sent alert speaks again. */
const RE_ALERT_GROWTH = 2;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface IssueRow {
  threadId: string;
  customerEmail: string;
  customerName: string | null;
  category: IssueCategory;
  designName: string | null;
  problem: string | null;
  summary: string;
  occurredAt: Date;
}

export interface DetectedPattern {
  key: string;
  kind: 'design' | 'category';
  headline: string;
  detail: string;
  customerCount: number;
  threadIds: string[];
  examples: string[];
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

const distinct = (rows: IssueRow[]) =>
  new Set(rows.map((r) => r.customerEmail.toLowerCase())).size;

/**
 * Find the patterns in a set of issue rows. Pure: `now` and the history span
 * are passed in so the thresholds can be tested without a database.
 *
 * `historySpanDays` is how far back the rows actually reach. Below
 * MIN_BASELINE_DAYS the category spike test is skipped entirely - with no
 * sense of normal, every category looks like a spike.
 */
export function detectPatterns(
  rows: IssueRow[],
  opts: { now: Date; historySpanDays: number }
): DetectedPattern[] {
  const now = opts.now.getTime();
  const patterns: DetectedPattern[] = [];

  // --- Design faults ---
  const designCutoff = now - DESIGN_WINDOW_DAYS * DAY_MS;
  const byDesign = new Map<string, IssueRow[]>();
  for (const r of rows) {
    if (!r.designName) continue;
    // Defects only. A size exchange is trade, not a fault - it has its own
    // pass below with a bar set where a real sizing problem lives.
    if (!isDefect(r.category)) continue;
    if (r.occurredAt.getTime() < designCutoff) continue;
    const list = byDesign.get(r.designName) || [];
    list.push(r);
    byDesign.set(r.designName, list);
  }

  for (const [design, group] of byDesign) {
    const customers = distinct(group);
    if (customers < DESIGN_MIN_CUSTOMERS) continue;

    const problems = Array.from(
      new Set(group.map((g) => g.problem).filter((p): p is string => !!p))
    );
    patterns.push({
      key: `design:${slug(design)}`,
      kind: 'design',
      headline: `${design}: ${customers} customers report a problem`,
      detail: problems.length
        ? `What they say: ${problems.join('; ')}`
        : `${group.length} complaints in the last ${DESIGN_WINDOW_DAYS} days`,
      customerCount: customers,
      threadIds: Array.from(new Set(group.map((g) => g.threadId))),
      examples: group.slice(0, 4).map((g) => `${g.customerName || g.customerEmail}: ${g.summary}`),
    });
  }

  // --- Sizing, per design ---
  // Judged on how much sizing this design draws, not on whether two people
  // wrote in. Either it is high on one design, or it has jumped against that
  // design's own previous window; a steady trickle stays in the daily report
  // where it belongs.
  const sizingByDesign = new Map<string, { current: IssueRow[]; prior: IssueRow[] }>();
  const priorCutoff = designCutoff - DESIGN_WINDOW_DAYS * DAY_MS;
  for (const r of rows) {
    if (!r.designName || r.category !== 'SIZING_FIT') continue;
    const at = r.occurredAt.getTime();
    const entry = sizingByDesign.get(r.designName) || { current: [], prior: [] };
    if (at >= designCutoff) entry.current.push(r);
    else if (at >= priorCutoff) entry.prior.push(r);
    sizingByDesign.set(r.designName, entry);
  }

  for (const [design, { current, prior }] of sizingByDesign) {
    const customers = distinct(current);
    const priorCustomers = distinct(prior);

    const isHigh = customers >= SIZING_MIN_CUSTOMERS;
    const hasJumped =
      customers >= SIZING_JUMP_FLOOR &&
      priorCustomers > 0 &&
      customers >= priorCustomers * SIZING_JUMP_MULTIPLE;
    if (!isHigh && !hasJumped) continue;

    patterns.push({
      key: `sizing:${slug(design)}`,
      kind: 'design',
      headline: `${design}: ${customers} customers asked to change size`,
      detail: hasJumped
        ? `That is up from ${priorCustomers} in the ${DESIGN_WINDOW_DAYS} days before. ` +
          `Worth checking the size chart and the photos on this one.`
        : `${customers} size changes on one design in ${DESIGN_WINDOW_DAYS} days. ` +
          `Worth checking the size chart and the photos on this one.`,
      customerCount: customers,
      threadIds: Array.from(new Set(current.map((c) => c.threadId))),
      examples: current.slice(0, 4).map((c) => `${c.customerName || c.customerEmail}: ${c.summary}`),
    });
  }

  // --- Category spikes ---
  if (opts.historySpanDays >= MIN_BASELINE_DAYS) {
    const windowStart = now - CATEGORY_WINDOW_HOURS * HOUR_MS;
    const baselineStart = now - BASELINE_DAYS * DAY_MS;
    // Number of windows the baseline covers, so the comparison is like for
    // like rather than a raw count against a raw count.
    const baselineWindows =
      (Math.min(BASELINE_DAYS, opts.historySpanDays) * 24 - CATEGORY_WINDOW_HOURS) /
      CATEGORY_WINDOW_HOURS;

    if (baselineWindows >= 1) {
      const categories = new Set(rows.map((r) => r.category).filter(isProblem));
      for (const category of categories) {
        const inCategory = rows.filter((r) => r.category === category);
        const current = inCategory.filter((r) => r.occurredAt.getTime() >= windowStart);
        const customers = distinct(current);
        if (customers < CATEGORY_MIN_CUSTOMERS) continue;

        const prior = inCategory.filter(
          (r) =>
            r.occurredAt.getTime() < windowStart &&
            r.occurredAt.getTime() >= baselineStart
        );
        const expected = prior.length / baselineWindows;
        if (current.length < SPIKE_MULTIPLE * expected) continue;

        const label = CATEGORY_LABEL[category];
        patterns.push({
          key: `category:${category}`,
          kind: 'category',
          headline: `${label}: ${customers} customers in ${CATEGORY_WINDOW_HOURS} hours`,
          detail:
            `Normal for this is about ${expected.toFixed(1)} messages per ` +
            `${CATEGORY_WINDOW_HOURS} hours - right now it is ${current.length}.`,
          customerCount: customers,
          threadIds: Array.from(new Set(current.map((c) => c.threadId))),
          examples: current
            .slice(0, 4)
            .map((c) => `${c.customerName || c.customerEmail}: ${c.summary}`),
        });
      }
    }
  }

  return patterns.sort((a, b) => b.customerCount - a.customerCount);
}

function esc(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderAlertHtml(pattern: DetectedPattern, base: string): string {
  let html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px">` +
    `<h2 style="color:#9a3412;margin-bottom:4px">${esc(pattern.headline)}</h2>` +
    `<p style="margin:4px 0 14px;color:#555">${esc(pattern.detail)}</p>`;

  if (pattern.examples.length) {
    html += `<p style="margin:0 0 4px"><b>What they wrote in</b></p><ul style="padding-left:20px">`;
    for (const e of pattern.examples) {
      html += `<li style="margin:4px 0">${esc(e)}</li>`;
    }
    html += `</ul>`;
  }

  html += `<p style="margin:14px 0 4px"><b>The threads</b></p><ul style="padding-left:20px">`;
  for (const id of pattern.threadIds.slice(0, 10)) {
    html += `<li style="margin:3px 0"><a href="${base}/inbox?thread=${id}">Open thread</a></li>`;
  }
  html += `</ul>`;

  const isSizing = pattern.key.startsWith('sizing:');
  html +=
    isSizing
      ? `<p style="color:#777;font-size:12px">Size alerts fire at ` +
        `${SIZING_MIN_CUSTOMERS} customers on one design within ` +
        `${DESIGN_WINDOW_DAYS} days, or when that design's size changes ` +
        `double against the ${DESIGN_WINDOW_DAYS} days before. A single size ` +
        `exchange is never reported.</p>`
      : pattern.kind === 'design'
        ? `<p style="color:#777;font-size:12px">Fault alerts fire at ` +
          `${DESIGN_MIN_CUSTOMERS} different customers reporting a print, ` +
          `garment or wrong-item problem on the same design within ` +
          `${DESIGN_WINDOW_DAYS} days.</p>`
        : `<p style="color:#777;font-size:12px">Category alerts fire when a ` +
          `category runs at ${SPIKE_MULTIPLE}x its own recent rate with at ` +
          `least ${CATEGORY_MIN_CUSTOMERS} customers.</p>`;

  return `${html}</div>`;
}

export interface PatternCheckStats {
  found: number;
  alerted: number;
}

/**
 * Look for patterns and speak about the new ones. Called on a short loop, so
 * everything here is cheap and the dedupe is the part that matters.
 */
export async function runPatternCheck(): Promise<PatternCheckStats> {
  const since = new Date(Date.now() - Math.max(DESIGN_WINDOW_DAYS, BASELINE_DAYS) * DAY_MS);

  const [rows, oldest] = await Promise.all([
    prisma.customerIssue.findMany({
      where: { occurredAt: { gte: since } },
      select: {
        threadId: true,
        customerEmail: true,
        customerName: true,
        category: true,
        designName: true,
        problem: true,
        summary: true,
        occurredAt: true,
      },
    }),
    prisma.customerIssue.findFirst({
      orderBy: { occurredAt: 'asc' },
      select: { occurredAt: true },
    }),
  ]);

  if (rows.length === 0) return { found: 0, alerted: 0 };

  const historySpanDays = oldest
    ? (Date.now() - oldest.occurredAt.getTime()) / DAY_MS
    : 0;

  const patterns = detectPatterns(rows, { now: new Date(), historySpanDays });
  if (patterns.length === 0) return { found: 0, alerted: 0 };

  const existing = await prisma.issueAlert.findMany({
    where: { key: { in: patterns.map((p) => p.key) } },
  });
  const seen = new Map(existing.map((e) => [e.key, e]));

  const fresh = patterns.filter((p) => {
    const prior = seen.get(p.key);
    if (!prior) return true;
    // Speak again only when it is spreading, not just because it is still true.
    return p.customerCount >= prior.customerCount + RE_ALERT_GROWTH;
  });

  if (fresh.length === 0) return { found: patterns.length, alerted: 0 };

  const base = process.env.NEXTAUTH_URL || 'https://selfservice.summitsoul.shop';
  const to =
    process.env.ISSUE_REPORT_EMAIL_TO ||
    process.env.ESCALATION_EMAIL_TO ||
    process.env.EVAL_EMAIL_TO ||
    'summitsoulbrand@gmail.com';

  const sender = await createOutboundEmailSender();

  for (const pattern of fresh) {
    try {
      if (sender) {
        await sender.sendMessage({
          to: [{ address: to }],
          fromName: 'Summit Soul Desk',
          subject: `Pattern: ${pattern.headline}`,
          bodyHtml: renderAlertHtml(pattern, base),
        });
      }
    } catch (err) {
      console.error('[issues] pattern email failed:', err);
    }

    const slackLines = [
      `*Pattern spotted - ${pattern.headline}*`,
      pattern.detail,
      ...pattern.examples.map((e) => `• ${e}`),
      ...pattern.threadIds.slice(0, 5).map((id) => `${base}/inbox?thread=${id}`),
    ];
    await postToIssueAlert(slackLines.join('\n'));

    // Recorded AFTER sending, so a send that throws is retried next pass
    // rather than being silently marked as delivered.
    await prisma.issueAlert.upsert({
      where: { key: pattern.key },
      create: {
        key: pattern.key,
        kind: 'PATTERN',
        label: pattern.headline,
        customerCount: pattern.customerCount,
      },
      update: {
        label: pattern.headline,
        customerCount: pattern.customerCount,
        lastSentAt: new Date(),
      },
    });
  }

  return { found: patterns.length, alerted: fresh.length };
}

export const __testing = {
  DESIGN_MIN_CUSTOMERS,
  CATEGORY_MIN_CUSTOMERS,
  CATEGORY_WINDOW_HOURS,
  MIN_BASELINE_DAYS,
};
