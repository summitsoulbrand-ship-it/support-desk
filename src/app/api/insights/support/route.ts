/**
 * Support insights aggregation
 * One payload for the Insights dashboard: common issues by channel, review
 * health, social volume, and per-product replacement analysis, with a
 * previous-period comparison for trend arrows. Cached per window.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { createShopifyClient } from '@/lib/shopify';
import { createJudgemeClient } from '@/lib/judgeme/client';
import { guessGender } from '@/lib/insights/gender';

export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<number, { at: number; data: unknown }>();

// "Replacement rate by product" only lists problem products: sold enough for
// the rate to be real, at or above the 5% complaint/retire threshold, and with
// enough replacements behind the rate to be a pattern rather than a one-off.
const PRODUCT_MIN_UNITS = 10;
const PRODUCT_MIN_REPLACEMENTS = 3;
// "High" is measured against the store, not against a number typed in once.
// The true store-wide rate is ~2.3%, so a fixed 5% bar flagged almost nothing
// (it was set when a truncated denominator inflated every rate ~2.5x). Twice
// the baseline keeps the table meaningful as the store moves, and the floor
// stops it flagging noise if the baseline ever drops very low.
const PRODUCT_RATE_MULTIPLE = 2;
const PRODUCT_RATE_FLOOR = 4;

// Replacement RATE is measured on a matured sales cohort, not a calendar
// window. A replacement is triggered by an older sale - median 11 days, and
// 95.4% land within 30 - so dividing this month's replacements by this
// month's sales compares two different sets of shirts (47% of the originals
// fell outside the window). Instead: take the shirts sold in a month that has
// already had 30 days to come back, and count every replacement traced to
// them. Same shirts top and bottom, and it reads as a real sentence.
const COHORT_MATURITY_DAYS = 30;
// Two months of sales, not one: at a ~2.3% rate a single month leaves most
// products with one or two replacements, which is too thin to separate a real
// problem from chance. Doubling the cohort doubles the evidence per product
// without touching maturity.
const COHORT_LENGTH_DAYS = 60;

/**
 * Map a replacement order's tags + note to a reason bucket. Matches the
 * tool's tags AND the store's historical manual tags ('too big', 'defect',
 * 'wrong shirt ordered', 'print placement', ...), case-insensitively.
 */
function classifyReplacementReason(tags: string[], note: string | null): string {
  const text = `${tags.join(' | ')} | ${note || ''}`.toLowerCase();
  // A bare 'neck' tag is how a tight crew neck gets recorded - the complaint
  // that sends people to the v-neck. Checked first: it is the specific reason,
  // where a size tag alongside it is only the generic one. Product names are
  // stripped first so 'V-Neck' in a note ("send the V neck in M") never reads
  // as a complaint.
  const complaint = text.replace(/v[\s-]?neck/g, ' ');
  if (
    tags.some((t) => t.trim().toLowerCase() === 'neck') ||
    complaint.includes('neck too tight') ||
    complaint.includes('tight neck') ||
    complaint.includes('neck opening') ||
    complaint.includes('neck hole') ||
    complaint.includes('neckline')
  )
    return 'neckTooTight';
  // A parcel that never arrived is not a garment failure. Tagged by the
  // detector at replacement time, so it stops hiding inside "Unspecified".
  if (
    tags.some((t) => t.trim().toLowerCase() === 'not delivered') ||
    complaint.includes('not delivered') ||
    complaint.includes('never delivered') ||
    complaint.includes('never received')
  )
    return 'notDelivered';
  if (text.includes('too small')) return 'tooSmall';
  if (text.includes('too large') || text.includes('too big')) return 'tooLarge';
  if (text.includes('color change') || text.includes('wrong color')) return 'colorChange';
  if (
    text.includes('defect') ||
    text.includes('print placement') ||
    text.includes('misprint') ||
    text.includes('damaged') ||
    text.includes('quality') ||
    text.includes('print issue')
  )
    return 'defect';
  if (text.includes('wrong shirt') || text.includes('wrong item') || text.includes('wrong size ordered') || text.includes('wrong design'))
    return 'wrongItem';
  return 'other';
}

/**
 * The order a replacement was created for. The tool writes the origin into
 * the note ("Replacement order for #33304 - ..."), which is the only link
 * between the two orders.
 */
function originalOrderNumber(note: string | null): string | null {
  const m = (note || '').match(/replacement order for #(\d+)/i);
  return m ? m[1] : null;
}

/**
 * Product title minus its garment suffix, so the same design can be matched
 * across cuts: 'Frog Wizard Kerfuffle V-Neck Heather' and 'Frog Wizard
 * Kerfuffle Premium' both reduce to 'frog wizard kerfuffle'. This is what
 * lets a v-neck replacement be traced back to the crew tee it replaced.
 */
function designStem(title: string): string {
  return title
    .toLowerCase()
    .replace(
      /\s*(v[\s-]?neck heather|v[\s-]?neck|premium ls|premium|long sleeve|ls|hoodie|sweatshirt|crewneck|kids tee|kids|youth|toddler|onesie|vintage)\b/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Which product actually failed. A replacement order lists what we SHIPPED,
 * which for a style swap is a different garment than the one the customer
 * complained about - counting the shipped item made the v-neck (the fix
 * people choose) look like the worst product in the store. Resolve back to
 * the line on the original order: exact title first, then the same design in
 * another cut, then a single-item original. Falls back to the shipped title
 * when the original can't be found or is genuinely ambiguous.
 */
function failedProductTitle(
  shippedTitle: string,
  originalItems: { title: string; quantity: number }[]
): { title: string; attributed: boolean } {
  if (originalItems.length === 0) return { title: shippedTitle, attributed: false };

  const exact = originalItems.find((li) => li.title === shippedTitle);
  if (exact) return { title: exact.title, attributed: true };

  const stem = designStem(shippedTitle);
  const sameDesign = originalItems.filter((li) => designStem(li.title) === stem);
  if (sameDesign.length > 0) return { title: sameDesign[0].title, attributed: true };

  const distinct = [...new Set(originalItems.map((li) => li.title))];
  if (distinct.length === 1) return { title: distinct[0], attributed: true };

  return { title: shippedTitle, attributed: false };
}

/**
 * Garment type from the product title (store naming conventions:
 * 'Premium' = Comfort Colors 1717, otherwise Gildan 64000 classic tee).
 */
function garmentType(title: string): string {
  const t = title.toLowerCase();
  if (t.includes('long sleeve')) return 'Long sleeve';
  if (t.includes('hoodie')) return 'Hoodie';
  if (t.includes('sweatshirt') || t.includes('crewneck')) return 'Sweatshirt';
  if (t.includes('kids') || t.includes('youth') || t.includes('toddler') || t.includes('onesie'))
    return 'Kids';
  // V-necks (Bella+Canvas 6405) are titled '<design> V-Neck' / '... V-Neck
  // Heather'. Checked before Premium so a v-neck never lands in a tee bucket.
  if (t.includes('v-neck') || t.includes('v neck') || t.includes('vneck'))
    return 'V-neck (Bella+Canvas)';
  if (t.includes('premium')) return 'Premium tee (Comfort Colors)';
  return 'Classic tee (Gildan)';
}

// All day-bucketing happens in the shop's timezone, not the server's (UTC) -
// otherwise evening emails land on "tomorrow" in the charts.
const SHOP_TIMEZONE = process.env.SHOP_TIMEZONE || 'America/Los_Angeles';
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHOP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** YYYY-MM-DD in the shop's timezone */
function localDayKey(d: Date): string {
  return dayFormatter.format(d);
}

function weekKey(d: Date): string {
  // Monday of the week containing d, computed on the shop-local calendar day
  const [y, m, day] = localDayKey(d).split('-').map(Number);
  const local = new Date(Date.UTC(y, m - 1, day));
  const dow = local.getUTCDay() || 7; // Monday-based weeks
  local.setUTCDate(local.getUTCDate() - dow + 1);
  return local.toISOString().slice(0, 10);
}

async function buildInsights(days: number) {
  const now = Date.now();
  const since = new Date(now - days * 24 * 60 * 60 * 1000);
  const prevSince = new Date(now - 2 * days * 24 * 60 * 60 * 1000);
  const DAY_MS = 24 * 60 * 60 * 1000;
  const cohortEnd = new Date(now - COHORT_MATURITY_DAYS * DAY_MS);
  const cohortStart = new Date(now - (COHORT_MATURITY_DAYS + COHORT_LENGTH_DAYS) * DAY_MS);

  // ---- Emails: intent distribution + sentiment + weekly trend ----
  const triages = await prisma.threadTriage.findMany({
    where: { updatedAt: { gte: prevSince } },
    select: { intent: true, entities: true, updatedAt: true },
  });

  const intents: Record<string, { count: number; prevCount: number }> = {};
  let upset = 0;
  const weeklyMap = new Map<string, Record<string, number>>();

  for (const t of triages) {
    const inWindow = t.updatedAt >= since;
    const bucket = (intents[t.intent] ||= { count: 0, prevCount: 0 });
    if (inWindow) bucket.count++;
    else bucket.prevCount++;

    if (inWindow) {
      const sentiment = (t.entities as { sentiment?: string } | null)?.sentiment;
      if (sentiment === 'frustrated' || sentiment === 'angry') upset++;

      const wk = weekKey(t.updatedAt);
      const row = weeklyMap.get(wk) || {};
      row[t.intent] = (row[t.intent] || 0) + 1;
      weeklyMap.set(wk, row);
    }
  }

  const weekly = [...weeklyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, counts]) => ({ week, ...counts }));

  // ---- Emails received per day (inbound message volume) ----
  const inboundMessages = await prisma.message.findMany({
    where: { direction: 'INBOUND', sentAt: { gte: since } },
    select: { sentAt: true },
  });
  const dailyMap = new Map<string, number>();
  // Seed every day in the window so quiet days show as zero (shop-local days)
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    dailyMap.set(localDayKey(d), 0);
  }
  for (const m of inboundMessages) {
    const day = localDayKey(m.sentAt);
    // Only count into seeded days - a UTC-edge message can't create a
    // "tomorrow" bucket anymore
    if (dailyMap.has(day)) dailyMap.set(day, (dailyMap.get(day) || 0) + 1);
  }
  const dailyEmails = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, count]) => ({ day: day.slice(5), count }));

  // ---- Reviews (Judge.me): rating distribution current vs previous ----
  const reviews = {
    total: 0,
    prevTotal: 0,
    lowStar: 0,
    avgRating: 0,
    prevAvgRating: 0,
    byRating: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<number, number>,
  };
  try {
    const judgeme = await createJudgemeClient();
    if (judgeme) {
      let ratingSum = 0;
      let prevRatingSum = 0;
      outer: for (let page = 1; page <= 8; page++) {
        const result = await judgeme.getRecentReviews(page, 24);
        for (const r of result.reviews) {
          const created = new Date(r.createdAt);
          if (created < prevSince) break outer; // older than both windows
          if (created >= since) {
            reviews.total++;
            ratingSum += r.rating;
            if (r.rating <= 3) reviews.lowStar++;
            reviews.byRating[r.rating] = (reviews.byRating[r.rating] || 0) + 1;
          } else {
            reviews.prevTotal++;
            prevRatingSum += r.rating;
          }
        }
        if (page >= result.totalPages) break;
      }
      reviews.avgRating = reviews.total ? ratingSum / reviews.total : 0;
      reviews.prevAvgRating = reviews.prevTotal ? prevRatingSum / reviews.prevTotal : 0;
    }
  } catch (err) {
    console.error('Insights: Judge.me aggregation failed:', err);
  }

  // ---- Social: comment volume ----
  const [comments, prevComments, adComments] = await Promise.all([
    prisma.socialComment.count({
      where: { commentedAt: { gte: since }, isPageOwner: false, deleted: false },
    }),
    prisma.socialComment.count({
      where: {
        commentedAt: { gte: prevSince, lt: since },
        isPageOwner: false,
        deleted: false,
      },
    }),
    prisma.socialComment.count({
      where: {
        commentedAt: { gte: since },
        isPageOwner: false,
        deleted: false,
        object: { type: 'AD' },
      },
    }),
  ]);

  // ---- Replacements per product (Shopify) ----
  const replacements = {
    total: 0,
    prevTotal: 0,
    // Replacements we could not trace to an original order, so they are still
    // counted against the shipped item. Shown on the dashboard as a caveat.
    unattributed: 0,
    // The sales month the rate is measured on (everything else on this card is
    // the selected window), so the dashboard can label it rather than imply
    // the numbers are current.
    cohortStart: cohortStart.toISOString().slice(0, 10),
    cohortEnd: cohortEnd.toISOString().slice(0, 10),
    // Store-wide rate for the cohort, and the bar a product must clear to be
    // listed (both percentages).
    baselineRate: 0,
    highRate: 0,
    reasons: {
      tooSmall: 0,
      tooLarge: 0,
      neckTooTight: 0,
      notDelivered: 0,
      colorChange: 0,
      defect: 0,
      wrongItem: 0,
      other: 0,
    },
    perProduct: [] as {
      title: string;
      unitsSold: number;
      replacements: number;
      rate: number;
      reasons: Record<string, number>;
    }[],
    topByVolume: [] as {
      title: string;
      unitsSold: number;
      replacements: number;
      rate: number;
      reasons: Record<string, number>;
    }[],
    byType: [] as {
      type: string;
      unitsSold: number;
      replacements: number;
      rate: number;
      reasons: Record<string, number>;
    }[],
    // Inferred from the billing first name (heuristic, US name list)
    byGender: {
      female: { total: 0, tooSmall: 0, tooLarge: 0 },
      male: { total: 0, tooSmall: 0, tooLarge: 0 },
      unknown: { total: 0, tooSmall: 0, tooLarge: 0 },
    },
  };
  try {
    const shopify = await createShopifyClient();
    if (shopify) {
      // Replacements, reaching back far enough to cover the sales cohort as
      // well as the trend windows
      const lookbackDays = Math.max(2 * days, COHORT_MATURITY_DAYS + COHORT_LENGTH_DAYS);
      const replacementOrders = await shopify.getReplacementOrders(
        new Date(now - lookbackDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      );
      const replaced = new Map<string, number>();
      // Reason mix per product title, so the table can say WHY it came back
      const reasonsByTitle = new Map<string, Record<string, number>>();
      const typeAgg = new Map<
        string,
        { replacements: number; reasons: Record<string, number> }
      >();
      // Replacement units SHIPPED inside the cohort window. ShopifyQL counts
      // these as sales, so they come back out of the denominator.
      const shippedInCohort = new Map<string, number>();

      // Trace every replacement back to the order it was created for, so the
      // failure lands on the product the customer complained about - and so we
      // know which sales cohort it belongs to.
      const originalOrders = await shopify.getOrderLineItemsByNames(
        replacementOrders
          .map((o) => originalOrderNumber(o.note))
          .filter((n): n is string => n !== null)
      );

      for (const order of replacementOrders) {
        const created = new Date(order.createdAt);
        const reason = classifyReplacementReason(order.tags, order.note);
        const originNo = originalOrderNumber(order.note);
        const origin = originNo ? originalOrders.get(originNo) : undefined;

        // --- Trend counters: replacement ACTIVITY in the selected window
        if (created >= since) {
          replacements.total++;
          replacements.reasons[reason as keyof typeof replacements.reasons]++;
          // Gender split (billing first name carries over from the original
          // order when the replacement is created)
          const gender = guessGender(order.billingFirstName);
          replacements.byGender[gender].total++;
          if (reason === 'tooSmall') replacements.byGender[gender].tooSmall++;
          if (reason === 'tooLarge') replacements.byGender[gender].tooLarge++;
        } else if (created >= prevSince) {
          replacements.prevTotal++;
        }

        if (created >= cohortStart && created < cohortEnd) {
          for (const li of order.lineItems) {
            shippedInCohort.set(
              li.title,
              (shippedInCohort.get(li.title) || 0) + li.quantity
            );
          }
        }

        // --- Cohort counters: replacements belonging to the matured sales
        // cohort, whenever they were created. A replacement we cannot trace
        // has no cohort, so it is disclosed rather than guessed at.
        if (!origin) {
          if (created >= since) replacements.unattributed++;
          continue;
        }
        const soldAt = new Date(origin.createdAt);
        if (soldAt < cohortStart || soldAt >= cohortEnd) continue;

        for (const li of order.lineItems) {
          const { title: failed } = failedProductTitle(li.title, origin.lineItems);
          replaced.set(failed, (replaced.get(failed) || 0) + li.quantity);
          const titleReasons = reasonsByTitle.get(failed) || {};
          titleReasons[reason] = (titleReasons[reason] || 0) + li.quantity;
          reasonsByTitle.set(failed, titleReasons);
          // Per garment-type reason mix
          const type = garmentType(failed);
          const agg = typeAgg.get(type) || { replacements: 0, reasons: {} };
          agg.replacements += li.quantity;
          agg.reasons[reason] = (agg.reasons[reason] || 0) + li.quantity;
          typeAgg.set(type, agg);
        }
      }

      // Denominator: units sold to customers in the cohort window, i.e. the
      // same shirts the numerator is counting, minus the replacements we
      // shipped free inside that window.
      const soldRaw = await shopify.getUnitsSoldByProduct(
        cohortStart.toISOString().slice(0, 10),
        cohortEnd.toISOString().slice(0, 10)
      );
      const sold = new Map<string, number>();
      for (const [title, units] of soldRaw) {
        sold.set(title, Math.max(0, units - (shippedInCohort.get(title) || 0)));
      }

      // Store-wide rate for this cohort - the bar every product is judged
      // against, and the context the dashboard prints on the card.
      const totalSold = [...sold.values()].reduce((a, b) => a + b, 0);
      const totalReplaced = [...replaced.values()].reduce((a, b) => a + b, 0);
      const baselineRate = totalSold > 0 ? (totalReplaced / totalSold) * 100 : 0;
      const highRate = Math.max(PRODUCT_RATE_MULTIPLE * baselineRate, PRODUCT_RATE_FLOOR);
      replacements.baselineRate = baselineRate;
      replacements.highRate = highRate;

      const titles = new Set([...sold.keys(), ...replaced.keys()]);
      const productRows = [...titles].map((title) => {
        const unitsSold = sold.get(title) || 0;
        const repl = replaced.get(title) || 0;
        return {
          title,
          unitsSold,
          replacements: repl,
          rate: unitsSold > 0 ? (repl / unitsSold) * 100 : repl > 0 ? 100 : 0,
          reasons: reasonsByTitle.get(title) || {},
        };
      });

      // Where the replacement volume actually sits. A bestseller can be the
      // single biggest source of replacements while sitting BELOW the store
      // rate, so it never shows up on the rate table - which is correct there
      // (it is not unusually bad) but leaves the biggest cost invisible.
      replacements.topByVolume = productRows
        .filter((p) => p.replacements > 0)
        .sort((a, b) => b.replacements - a.replacements || b.rate - a.rate)
        .slice(0, 8);

      replacements.perProduct = productRows
        // Enough sales for the rate to mean anything, at least a few units
        // actually back (one-offs are chance, not a pattern), and a rate well
        // clear of the store baseline. Everything else is noise on this table.
        .filter(
          (p) =>
            p.unitsSold > PRODUCT_MIN_UNITS &&
            p.rate >= highRate &&
            p.replacements >= PRODUCT_MIN_REPLACEMENTS
        )
        .sort((a, b) => b.rate - a.rate || b.replacements - a.replacements)
        .slice(0, 25);

      // Garment-type rollup: units sold + replacement rate + reason mix
      const soldByType = new Map<string, number>();
      for (const [title, units] of sold) {
        const type = garmentType(title);
        soldByType.set(type, (soldByType.get(type) || 0) + units);
      }
      const allTypes = new Set([...soldByType.keys(), ...typeAgg.keys()]);
      replacements.byType = [...allTypes]
        .map((type) => {
          const unitsSold = soldByType.get(type) || 0;
          const agg = typeAgg.get(type) || { replacements: 0, reasons: {} };
          return {
            type,
            unitsSold,
            replacements: agg.replacements,
            rate: unitsSold > 0 ? (agg.replacements / unitsSold) * 100 : 0,
            reasons: agg.reasons,
          };
        })
        .sort((a, b) => b.unitsSold - a.unitsSold);
    }
  } catch (err) {
    console.error('Insights: Shopify replacement aggregation failed:', err);
  }

  // ---- Team: per-agent replies + first-response time ----
  const windowMessages = await prisma.message.findMany({
    where: { sentAt: { gte: since } },
    select: { threadId: true, direction: true, sentAt: true, sentByUserId: true },
    orderBy: { sentAt: 'asc' },
  });
  const byThread = new Map<string, typeof windowMessages>();
  for (const m of windowMessages) {
    const arr = byThread.get(m.threadId);
    if (arr) arr.push(m);
    else byThread.set(m.threadId, [m]);
  }
  const responseGapsMs: number[] = [];
  const agentReplyCounts = new Map<string, number>();
  const agentGapMs = new Map<string, number[]>();
  for (const msgs of byThread.values()) {
    let pendingInboundAt: Date | null = null;
    for (const m of msgs) {
      if (m.direction === 'INBOUND') {
        if (pendingInboundAt === null) pendingInboundAt = m.sentAt;
      } else {
        if (m.sentByUserId) {
          agentReplyCounts.set(m.sentByUserId, (agentReplyCounts.get(m.sentByUserId) || 0) + 1);
        }
        if (pendingInboundAt !== null) {
          const gap = m.sentAt.getTime() - pendingInboundAt.getTime();
          if (gap >= 0) {
            responseGapsMs.push(gap);
            if (m.sentByUserId) {
              const a = agentGapMs.get(m.sentByUserId);
              if (a) a.push(gap);
              else agentGapMs.set(m.sentByUserId, [gap]);
            }
          }
          pendingInboundAt = null; // this inbound is now answered
        }
      }
    }
  }
  const median = (arr: number[]): number => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const userIds = [...agentReplyCounts.keys()];
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true },
      })
    : [];
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const agents = userIds
    .map((id) => ({
      userId: id,
      name: userName.get(id) || 'Unknown',
      replies: agentReplyCounts.get(id) || 0,
      medianResponseMins: Math.round(median(agentGapMs.get(id) || []) / 60000),
    }))
    .sort((a, b) => b.replies - a.replies);
  const team = {
    totalReplies: [...agentReplyCounts.values()].reduce((a, b) => a + b, 0),
    medianFirstResponseMins: Math.round(median(responseGapsMs) / 60000),
    avgFirstResponseMins: responseGapsMs.length
      ? Math.round(responseGapsMs.reduce((a, b) => a + b, 0) / responseGapsMs.length / 60000)
      : 0,
    agents,
  };

  return {
    windowDays: days,
    generatedAt: new Date().toISOString(),
    emails: {
      intents: Object.entries(intents).map(([intent, v]) => ({ intent, ...v })),
      upset,
      weekly,
      daily: dailyEmails,
      received: inboundMessages.length,
      total: triages.filter((t) => t.updatedAt >= since).length,
    },
    reviews,
    social: { comments, prevComments, adComments },
    replacements,
    team,
  };
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const days = request.nextUrl.searchParams.get('days') === '14' ? 14 : 30;

    const cached = cache.get(days);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return NextResponse.json(cached.data);
    }

    const data = await buildInsights(days);
    cache.set(days, { at: Date.now(), data });

    return NextResponse.json(data);
  } catch (err) {
    console.error('Error building insights:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
