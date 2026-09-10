/**
 * The daily customer report - what came in, what is worth her attention, and
 * which designs are getting complained about.
 *
 * It always sends, even on a quiet day. This report exists because the daily
 * one stopped arriving, and silence is exactly the failure it replaces: an
 * empty inbox and a broken job look identical when nothing shows up. A day
 * with nothing in it says so in one line.
 *
 * Structure follows how Pati reads: the headline first, then only the things
 * that need her, then the counts. Categories carry their own recent average
 * beside them, because "6 shipping complaints" means nothing without knowing
 * whether 6 is a normal Tuesday.
 */

import { IssueCategory, IssueSeverity } from '@prisma/client';
import prisma from '@/lib/db';
import { createOutboundEmailSender } from '@/lib/email';
import { postToIssueReport } from '@/lib/slack';
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  isDefect,
  isProblem,
} from '@/lib/issues/categories';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Days the "normal for this" average is measured over. */
const BASELINE_DAYS = 7;
/** How far back the design watchlist looks. */
const DESIGN_WINDOW_DAYS = parseInt(
  process.env.ISSUE_DESIGN_WINDOW_DAYS || '14',
  10
);
/** Complaints on one design before it makes the watchlist. */
const DESIGN_WATCH_MIN = parseInt(process.env.ISSUE_DESIGN_ALERT_MIN || '2', 10);

function esc(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface DailyReportStats {
  total: number;
  problems: number;
  highSeverity: number;
  designsWatched: number;
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
  occurredAt: Date;
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
  occurredAt: true,
} as const;

/**
 * Designs with several people reporting a FAULT, worst first. Size exchanges
 * are not faults and have their own list - mixing them in buried a frog
 * printed with five legs underneath four people wanting a bigger shirt.
 */
export function designWatchlist(
  rows: Row[],
  minCustomers = DESIGN_WATCH_MIN
): {
  design: string;
  customers: number;
  problems: string[];
  threadIds: string[];
}[] {
  const byDesign = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.designName || !isDefect(r.category)) continue;
    const list = byDesign.get(r.designName) || [];
    list.push(r);
    byDesign.set(r.designName, list);
  }

  return Array.from(byDesign.entries())
    .map(([design, group]) => ({
      design,
      customers: new Set(group.map((g) => g.customerEmail.toLowerCase())).size,
      problems: Array.from(
        new Set(group.map((g) => g.problem).filter((p): p is string => !!p))
      ),
      threadIds: Array.from(new Set(group.map((g) => g.threadId))),
    }))
    .filter((d) => d.customers >= minCustomers)
    .sort((a, b) => b.customers - a.customers);
}

/**
 * Size changes per design: how many this window, and how many the window
 * before, so a number can be read as rising, flat or falling.
 *
 * This is what Pati asked for in place of single-shirt alerts - the overall
 * trend per product. A lone size exchange never appears anywhere in the
 * report; a design that keeps drawing them shows up here with its own history
 * beside it.
 */
export function sizingTrend(
  current: Row[],
  prior: Row[]
): { design: string; customers: number; before: number }[] {
  const count = (rows: Row[]) => {
    const m = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!r.designName || r.category !== 'SIZING_FIT') continue;
      const set = m.get(r.designName) || new Set<string>();
      set.add(r.customerEmail.toLowerCase());
      m.set(r.designName, set);
    }
    return m;
  };

  const now = count(current);
  const before = count(prior);

  return Array.from(now.entries())
    .map(([design, customers]) => ({
      design,
      customers: customers.size,
      before: before.get(design)?.size ?? 0,
    }))
    .sort((a, b) => b.customers - a.customers || a.design.localeCompare(b.design));
}

/** Category counts for the day, each with its recent daily average. */
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

export async function sendDailyIssueReport(
  now = new Date()
): Promise<DailyReportStats> {
  const dayStart = new Date(now.getTime() - DAY_MS);
  const baselineStart = new Date(dayStart.getTime() - BASELINE_DAYS * DAY_MS);
  const designStart = new Date(now.getTime() - DESIGN_WINDOW_DAYS * DAY_MS);

  const sizingPriorStart = new Date(designStart.getTime() - DESIGN_WINDOW_DAYS * DAY_MS);

  const [today, baseline, designPool, sizingPrior] = await Promise.all([
    prisma.customerIssue.findMany({
      where: { occurredAt: { gte: dayStart, lte: now } },
      select: SELECT,
      orderBy: { occurredAt: 'desc' },
    }),
    prisma.customerIssue.findMany({
      where: { occurredAt: { gte: baselineStart, lt: dayStart } },
      select: SELECT,
    }),
    prisma.customerIssue.findMany({
      where: { occurredAt: { gte: designStart, lte: now } },
      select: SELECT,
    }),
    prisma.customerIssue.findMany({
      where: {
        category: 'SIZING_FIT',
        occurredAt: { gte: sizingPriorStart, lt: designStart },
      },
      select: SELECT,
    }),
  ]);

  const problems = today.filter((r) => isProblem(r.category));
  // A size exchange is never a single-shirt emergency, however upset the
  // customer sounded (Pati, 2026-09-10). It is counted, it feeds the per-design
  // trend below, and it stays out of the list that says "needs your eyes".
  const high = problems.filter(
    (r) => r.severity === 'HIGH' && r.category !== 'SIZING_FIT'
  );
  const watchlist = designWatchlist(designPool);
  const sizing = sizingTrend(designPool, sizingPrior);
  const breakdown = categoryBreakdown(today, baseline);

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

  // --- Email ---
  let html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px">`;
  html += `<h2 style="margin-bottom:2px">Customer report - ${esc(dateLabel)}</h2>`;
  html +=
    `<p style="margin:0 0 18px;color:#555">` +
    (today.length === 0
      ? `No customer emails came in over the last 24 hours.`
      : `${today.length} customer ${today.length === 1 ? 'email' : 'emails'} ` +
        `in the last 24 hours. ${problems.length} reported a problem.`) +
    `</p>`;

  if (high.length > 0) {
    html +=
      `<h3 style="margin-bottom:4px;color:#9a3412">Needs your eyes (${high.length})</h3>` +
      `<ul style="margin:4px 0 18px;padding-left:20px">`;
    for (const r of high) {
      const who = r.customerName || r.customerEmail;
      html +=
        `<li style="margin:6px 0"><b>${esc(who)}</b> - ${esc(r.summary)}` +
        (r.designName ? ` <span style="color:#777">(${esc(r.designName)})</span>` : '') +
        ` <a href="${base}/inbox?thread=${r.threadId}" style="font-size:12px">open</a></li>`;
    }
    html += `</ul>`;
  }

  if (watchlist.length > 0) {
    html +=
      `<h3 style="margin-bottom:4px">Designs to look at (${watchlist.length})</h3>` +
      `<p style="margin:0 0 6px;color:#777;font-size:12px">` +
      `Same design, several different customers, last ${DESIGN_WINDOW_DAYS} days.</p>` +
      `<ul style="margin:4px 0 18px;padding-left:20px">`;
    for (const d of watchlist) {
      html +=
        `<li style="margin:6px 0"><b>${esc(d.design)}</b> - ` +
        `${d.customers} customers` +
        (d.problems.length ? `: ${esc(d.problems.join('; '))}` : '') +
        ` <a href="${base}/inbox?thread=${d.threadIds[0]}" style="font-size:12px">open</a></li>`;
    }
    html += `</ul>`;
  }

  if (sizing.length > 0) {
    html +=
      `<h3 style="margin-bottom:4px">Size changes by design (${DESIGN_WINDOW_DAYS} days)</h3>` +
      `<p style="margin:0 0 6px;color:#777;font-size:12px">` +
      `Ordinary trade, not faults - shown so you can see which designs run ` +
      `small or large. The number beside it is the ${DESIGN_WINDOW_DAYS} days before.</p>` +
      `<table style="border-collapse:collapse;font-size:14px;margin:4px 0 18px">`;
    for (const t of sizing) {
      const rising = t.before > 0 && t.customers >= t.before * 2;
      html +=
        `<tr>` +
        `<td style="padding:3px 14px 3px 0">${esc(t.design)}</td>` +
        `<td style="padding:3px 14px 3px 0;text-align:right"><b>${t.customers}</b></td>` +
        `<td style="padding:3px 0;color:${rising ? '#9a3412' : '#999'};font-size:12px">` +
        `was ${t.before}${rising ? ' - rising' : ''}</td>` +
        `</tr>`;
    }
    html += `</table>`;
  }

  if (breakdown.length > 0) {
    html +=
      `<h3 style="margin-bottom:4px">What people wrote about</h3>` +
      `<table style="border-collapse:collapse;font-size:14px;margin:4px 0 18px">`;
    for (const b of breakdown) {
      const avg = b.average.toFixed(1);
      const hot = b.count > b.average * 1.5 && b.count >= 3;
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
    `Built from the support inbox only - social comments and reviews are not ` +
    `in here. A design is only named when the customer said which one or ` +
    `their order had just the one, so some complaints stay unattributed. ` +
    `Size changes never appear as something needing your attention - they ` +
    `are counted above and only raise an alarm when one design starts ` +
    `drawing a lot of them.</p>` +
    `</div>`;

  let sent = false;
  try {
    const sender = await createOutboundEmailSender();
    if (sender) {
      const subject =
        today.length === 0
          ? `Customer report: a quiet day`
          : `Customer report: ${problems.length} problems` +
            (high.length ? `, ${high.length} need you` : '') +
            (watchlist.length ? `, ${watchlist.length} designs to check` : '');
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

  // --- Slack: the headline only, so the channel stays scannable ---
  // This goes to the DAILY REPORTS channel, never to escalations (Pati,
  // 2026-09-10). Escalations is where Jaki puts a thread that needs Pati
  // today; a report of everything that came in is not that, and burying one
  // inside the other is how both stop being read. With no daily-reports
  // webhook set it simply posts nowhere - the email still arrives.
  if (problems.length > 0 || watchlist.length > 0 || sizing.length > 0) {
    const lines = [
      `*Customer report - ${dateLabel}*`,
      `${today.length} emails, ${problems.length} problems, ${high.length} need you.`,
    ];
    for (const d of watchlist.slice(0, 5)) {
      lines.push(`• ${d.design}: ${d.customers} customers - ${d.problems.join('; ')}`);
    }
    const risingSizes = sizing.filter((t) => t.before > 0 && t.customers >= t.before * 2);
    for (const t of risingSizes.slice(0, 3)) {
      lines.push(`• ${t.design}: size changes up to ${t.customers} from ${t.before}`);
    }
    await postToIssueReport(lines.join('\n'));
  }

  return {
    total: today.length,
    problems: problems.length,
    highSeverity: high.length,
    designsWatched: watchlist.length,
    sent,
  };
}
