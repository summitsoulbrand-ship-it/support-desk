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

export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<number, { at: number; data: unknown }>();

const REASON_TAGS = {
  tooSmall: 'Too small',
  tooLarge: 'Too large',
  colorChange: 'Color change',
} as const;

function weekKey(d: Date): string {
  const date = new Date(d);
  const day = date.getDay() || 7; // Monday-based weeks
  date.setDate(date.getDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

async function buildInsights(days: number) {
  const now = Date.now();
  const since = new Date(now - days * 24 * 60 * 60 * 1000);
  const prevSince = new Date(now - 2 * days * 24 * 60 * 60 * 1000);

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
    reasons: { tooSmall: 0, tooLarge: 0, colorChange: 0, other: 0 },
    perProduct: [] as {
      title: string;
      unitsSold: number;
      replacements: number;
      rate: number;
    }[],
  };
  try {
    const shopify = await createShopifyClient();
    if (shopify) {
      const orders = await shopify.getOrderLineItemSummaries(
        prevSince.toISOString().slice(0, 10)
      );

      const sold = new Map<string, number>();
      const replaced = new Map<string, number>();

      for (const order of orders) {
        const created = new Date(order.createdAt);
        const isReplacement = order.tags.some(
          (t) => t.toLowerCase() === 'replacement'
        );
        const inWindow = created >= since;

        if (isReplacement) {
          if (inWindow) {
            replacements.total++;
            if (order.tags.includes(REASON_TAGS.tooSmall)) replacements.reasons.tooSmall++;
            else if (order.tags.includes(REASON_TAGS.tooLarge)) replacements.reasons.tooLarge++;
            else if (order.tags.includes(REASON_TAGS.colorChange)) replacements.reasons.colorChange++;
            else replacements.reasons.other++;

            for (const li of order.lineItems) {
              replaced.set(li.title, (replaced.get(li.title) || 0) + li.quantity);
            }
          } else {
            replacements.prevTotal++;
          }
          continue; // replacement orders don't count as organic sales
        }

        if (inWindow) {
          for (const li of order.lineItems) {
            sold.set(li.title, (sold.get(li.title) || 0) + li.quantity);
          }
        }
      }

      replacements.perProduct = [...sold.entries()]
        .map(([title, unitsSold]) => ({
          title,
          unitsSold,
          replacements: replaced.get(title) || 0,
          rate: unitsSold > 0 ? ((replaced.get(title) || 0) / unitsSold) * 100 : 0,
        }))
        .filter((p) => p.replacements > 0 || p.unitsSold >= 5)
        .sort((a, b) => b.rate - a.rate || b.replacements - a.replacements)
        .slice(0, 25);
    }
  } catch (err) {
    console.error('Insights: Shopify replacement aggregation failed:', err);
  }

  return {
    windowDays: days,
    generatedAt: new Date().toISOString(),
    emails: {
      intents: Object.entries(intents).map(([intent, v]) => ({ intent, ...v })),
      upset,
      weekly,
      total: triages.filter((t) => t.updatedAt >= since).length,
    },
    reviews,
    social: { comments, prevComments, adComments },
    replacements,
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
