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
 *
 * Two sections print messages IN FULL rather than counting them, because a
 * count is useless for both (Pati, 2026-09-16):
 *
 *  - PRINT problems. Rare enough to read every one - 7 in 30 days - and the
 *    detail is the whole point. Six of those seven reached her as nothing but
 *    a "+1" in the count column, one of them "text blends into blue shirt, not
 *    readable", which is a garment-color decision she can act on and never
 *    saw. It is listed whether or not anyone else reported it.
 *
 *  - CHECKOUT and PAYMENT failures, once more than one person hits them.
 *    Nobody writes in about a broken checkout; they leave. So two strangers
 *    bothering to write is already a lot of lost orders, far below the spike
 *    alarm's bar of five. On 2026-09-11 three customers hit one
 *    payment-method bug in a day and the report said "Website or checkout: 5".
 *
 * The Slack copy carries two counts the email does not: comments on Facebook
 * and Instagram, and Judge.me reviews (Pati, 2026-09-16). The report is still
 * built from EMAIL - nothing from those channels is classified, attributed to
 * a design, or fed to the pattern alarm - but the inbox is only part of what
 * customers said in a day, and a quiet inbox beside a loud comment thread is a
 * misleading picture. See channels.ts.
 *
 * And one section is GONE: size changes per design. A size exchange is
 * ordinary trade on a unisex tee, and a per-shirt breakdown of it is not a
 * pattern (Pati, 2026-09-16). Sizing still appears in the day's counts.
 */

import { IssueCategory, IssueSeverity } from '@prisma/client';
import prisma from '@/lib/db';
import { createOutboundEmailSender } from '@/lib/email';
import { postToIssueReport } from '@/lib/slack';
import { channelLines, reviewCounts, socialCounts } from '@/lib/issues/channels';
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  SEVERITY_RANK,
  isCheckout,
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

function esc(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface DailyReportStats {
  total: number;
  problems: number;
  highSeverity: number;
  designsWatched: number;
  printProblems: number;
  /** Distinct customers a checkout or payment failure stopped, 0 below the floor. */
  checkoutBlocked: number;
  /** Null when the channel could not be read - never confuse that with none. */
  socialComments: number | null;
  reviews: number | null;
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
  blockedPurchase: boolean | null;
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
  detail: true,
  blockedPurchase: true,
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
 * Every print or color complaint in the window, in full.
 *
 * Deliberately NOT gated on two customers saying the same thing. A print
 * problem is rare - seven in thirty days - and one person is enough, because
 * what they describe is usually a decision rather than a fluke: "text blends
 * into blue shirt" is a garment color to stop offering, "lettering was not
 * starlight" is a color that did not survive the print file. Waiting for a
 * second stranger to hit the same one just means shipping more of them.
 *
 * Designs with several customers still get their own watchlist above; this
 * list runs alongside it and repeats nothing, because the watchlist carries
 * counts and this carries words.
 */
export function printProblems(rows: Row[]): {
  who: string;
  design: string | null;
  problem: string | null;
  detail: string | null;
  summary: string;
  severity: IssueSeverity;
  threadId: string;
}[] {
  return rows
    .filter((r) => r.category === 'PRINT_QUALITY')
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        b.occurredAt.getTime() - a.occurredAt.getTime()
    )
    .map((r) => ({
      who: r.customerName || r.customerEmail,
      design: r.designName,
      problem: r.problem,
      detail: r.detail,
      summary: r.summary,
      severity: r.severity,
      threadId: r.threadId,
    }));
}

/**
 * Checkout, payment and code failures - but only the ones that actually
 * stopped a sale, and only once more than one person has hit them.
 *
 * Both halves of that matter. Without `blockedPurchase` the list fills with
 * people asking whether a sale is on: of 32 discount-code messages in 30 days,
 * most were questions. And a lone "my code would not apply" is a support
 * ticket, not news for the owner - it becomes news when it is two people,
 * because for every customer who writes in about a checkout that will not
 * submit there are many who simply close the tab.
 *
 * Returns an empty list below the floor, so the section disappears entirely
 * rather than showing a one.
 */
export function checkoutProblems(
  rows: Row[],
  minCustomers = CHECKOUT_MIN_CUSTOMERS
): {
  customers: number;
  items: {
    who: string;
    problem: string | null;
    detail: string | null;
    summary: string;
    category: IssueCategory;
    threadId: string;
  }[];
} {
  const blocked = rows.filter(
    (r) => isCheckout(r.category) && r.blockedPurchase === true
  );
  const customers = new Set(blocked.map((r) => r.customerEmail.toLowerCase())).size;
  if (customers < minCustomers) return { customers, items: [] };

  return {
    customers,
    items: blocked
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .map((r) => ({
        who: r.customerName || r.customerEmail,
        problem: r.problem,
        detail: r.detail,
        summary: r.summary,
        category: r.category,
        threadId: r.threadId,
      })),
  };
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

  const checkoutStart = new Date(now.getTime() - CHECKOUT_WINDOW_HOURS * 60 * 60 * 1000);

  const [today, baseline, designPool, checkoutPool] = await Promise.all([
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
        category: { in: ['WEBSITE_CHECKOUT', 'DISCOUNT_CODE'] },
        blockedPurchase: true,
        occurredAt: { gte: checkoutStart, lte: now },
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
  const prints = printProblems(today);
  const checkout = checkoutProblems(checkoutPool);
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
        // An angry print complaint belongs in both lists - this one for
        // triage, the one below for what to change - so say it is the same
        // person rather than letting it read as two complaints.
        (r.category === 'PRINT_QUALITY'
          ? ` <span style="color:#777;font-size:12px">(detail below)</span>`
          : '') +
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

  if (prints.length > 0) {
    html +=
      `<h3 style="margin-bottom:4px">Print and color problems (${prints.length})</h3>` +
      `<p style="margin:0 0 6px;color:#777;font-size:12px">` +
      `Everything customers said about the printing itself, in their words. ` +
      `Listed even when only one person said it - a print you cannot see on ` +
      `a shirt color is worth knowing about the first time.</p>` +
      `<ul style="margin:4px 0 18px;padding-left:20px">`;
    for (const r of prints) {
      html +=
        `<li style="margin:8px 0">` +
        `<b>${esc(r.problem || r.summary)}</b>` +
        (r.design
          ? ` <span style="color:#777">on ${esc(r.design)}</span>`
          : ` <span style="color:#999">(design not named)</span>`) +
        (r.detail ? `<br><span style="color:#444">${esc(r.detail)}</span>` : '') +
        `<br><span style="color:#999;font-size:12px">${esc(r.who)}` +
        (r.severity === 'HIGH' ? ` - upset` : '') +
        ` <a href="${base}/inbox?thread=${r.threadId}">open</a></span></li>`;
    }
    html += `</ul>`;
  }

  if (checkout.items.length > 0) {
    html +=
      `<h3 style="margin-bottom:4px;color:#9a3412">` +
      `People who could not buy (${checkout.customers})</h3>` +
      `<p style="margin:0 0 6px;color:#777;font-size:12px">` +
      `${checkout.customers} different customers hit a checkout, payment or ` +
      `code failure in the last ${CHECKOUT_WINDOW_HOURS} hours. Only messages ` +
      `where something actually stopped the sale are here - questions about ` +
      `codes are not. For everyone who writes in, more just close the tab.</p>` +
      `<ul style="margin:4px 0 18px;padding-left:20px">`;
    for (const r of checkout.items) {
      html +=
        `<li style="margin:8px 0">` +
        `<b>${esc(r.problem || r.summary)}</b>` +
        `<br><span style="color:#444">${esc(r.detail || r.summary)}</span>` +
        `<br><span style="color:#999;font-size:12px">${esc(r.who)} - ` +
        `${esc(CATEGORY_LABEL[r.category])} ` +
        `<a href="${base}/inbox?thread=${r.threadId}">open</a></span></li>`;
    }
    html += `</ul>`;
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
    `Size changes are counted above and nothing more - they are ordinary ` +
    `trade on a unisex tee, so there is no per-shirt breakdown and no alarm ` +
    `for them.</p>` +
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
            (watchlist.length ? `, ${watchlist.length} designs to check` : '') +
            // Loud in the subject line, because it is the one thing here that
            // is costing money right now rather than describing yesterday.
            (checkout.items.length
              ? `, ${checkout.customers} could not check out`
              : '');
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

  // --- The other two channels, for Slack only ---
  //
  // Read AFTER the email is sent, and never allowed to throw, so a slow or
  // broken Judge.me cannot delay or lose the report itself. Each returns null
  // rather than zero when it cannot read, and the line says so.
  const [social, reviews] = await Promise.all([socialCounts(now), reviewCounts(now)]);

  // --- Slack: the headline only, so the channel stays scannable ---
  // This goes to the DAILY REPORTS channel, never to escalations (Pati,
  // 2026-09-10). Escalations is where Jaki puts a thread that needs Pati
  // today; a report of everything that came in is not that, and burying one
  // inside the other is how both stop being read. With no daily-reports
  // webhook set it simply posts nowhere - the email still arrives.
  {
    // Posts every day, including a quiet one. Same reason the email does: a
    // day with nothing in it and a job that died look identical when nothing
    // shows up, and now that the social and review counts live here, a silent
    // channel would also hide those.
    const lines = [
      `*Customer report - ${dateLabel}*`,
      `${today.length} emails, ${problems.length} problems, ${high.length} need you.`,
      ...channelLines(social, reviews),
    ];
    if (checkout.items.length) {
      lines.push(
        `:rotating_light: ${checkout.customers} customers could not check out ` +
          `in ${CHECKOUT_WINDOW_HOURS}h - ${checkout.items[0].problem || checkout.items[0].summary}`
      );
    }
    for (const d of watchlist.slice(0, 5)) {
      lines.push(`• ${d.design}: ${d.customers} customers - ${d.problems.join('; ')}`);
    }
    for (const r of prints.slice(0, 3)) {
      lines.push(
        `• Print: ${r.problem || r.summary}${r.design ? ` (${r.design})` : ''}`
      );
    }
    await postToIssueReport(lines.join('\n'));
  }

  return {
    total: today.length,
    problems: problems.length,
    highSeverity: high.length,
    designsWatched: watchlist.length,
    printProblems: prints.length,
    checkoutBlocked: checkout.items.length ? checkout.customers : 0,
    socialComments: social?.comments ?? null,
    reviews: reviews?.total ?? null,
    sent,
  };
}
