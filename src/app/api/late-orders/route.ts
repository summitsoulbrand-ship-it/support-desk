/**
 * Late orders API
 * Orders not delivered within N days (default 13) of being ordered, from the
 * last 3 months.
 *
 * Printify is the only source with real delivery status: a shipment carries
 * delivered_at when the carrier confirms delivery (Shopify's fulfillment status
 * never sees that for these POD orders, and Printify does NOT set shipped_at).
 * The global Printify order cache is currently incomplete for recent orders, so
 * we query Printify LIVE - but cache the computed result for 30 minutes so we
 * do NOT re-pull everything on every load. ?fresh=1 forces a fresh pull.
 *
 * "Late" = no shipment has delivered_at AND the order was placed >= N days ago.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { PrintifyClient } from '@/lib/printify';
import { PrintifyConfig, PrintifyOrder } from '@/lib/printify/types';
import { decryptJson } from '@/lib/encryption';
import { cacheGet, cacheSet, CACHE_TTL } from '@/lib/cache';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 90; // last 3 months
const PAGE_SIZE = 50;
const BATCH = 8; // pages fetched in parallel per round
const MAX_PAGES = 120; // hard safety cap against a runaway loop

interface LateOrder {
  printifyOrderId: string;
  orderName: string;
  daysSinceOrdered: number;
  daysSinceShipped: number | null;
  status: string;
  carrier: string | null;
  trackingUrl: string | null;
  printifyUrl: string;
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const thresholdDays = Math.max(
    1,
    parseInt(request.nextUrl.searchParams.get('days') || '13', 10) || 13
  );
  const fresh = request.nextUrl.searchParams.get('fresh') === '1';
  const cacheKey = `late-orders:v1:${thresholdDays}`;

  if (!fresh) {
    const cached = await cacheGet<{ thresholdDays: number; count: number; orders: LateOrder[]; cachedAt: string }>(
      cacheKey
    );
    if (cached) return NextResponse.json({ ...cached, cached: true });
  }

  const settings = await prisma.integrationSettings.findUnique({
    where: { type: 'PRINTIFY' },
  });
  if (!settings || !settings.enabled) {
    return NextResponse.json({ error: 'Printify is not connected' }, { status: 503 });
  }
  const config = decryptJson<PrintifyConfig>(settings.encryptedData);
  const client = new PrintifyClient(config);

  const now = Date.now();
  const windowStart = now - LOOKBACK_DAYS * DAY_MS;
  const late: LateOrder[] = [];

  // Printify returns orders newest-first. Fetch pages in parallel batches and
  // stop once a whole batch predates the 90-day window.
  let nextPage = 1;
  let lastPage = MAX_PAGES;
  let done = false;

  while (!done && nextPage <= MAX_PAGES && nextPage <= lastPage) {
    const pageNums: number[] = [];
    for (let i = 0; i < BATCH && nextPage <= MAX_PAGES; i++) pageNums.push(nextPage++);

    const results = await Promise.all(
      pageNums.map((p) => client.listOrdersPage(p, PAGE_SIZE))
    );

    let batchHadInWindow = false;
    for (const res of results) {
      if (res.last_page) lastPage = res.last_page;
      for (const order of res.data || []) {
        const status = (order.status || '').toLowerCase();
        if (status.includes('cancel')) continue;

        const orderedAt = order.created_at ? new Date(order.created_at).getTime() : NaN;
        if (Number.isNaN(orderedAt)) continue;
        if (orderedAt >= windowStart) batchHadInWindow = true;
        if (orderedAt < windowStart) continue;

        const daysSinceOrdered = Math.floor((now - orderedAt) / DAY_MS);
        if (daysSinceOrdered < thresholdDays) continue;

        const shipments = order.shipments || [];
        if (shipments.some((s) => s.delivered_at)) continue; // delivered -> not late

        const fulfilledAt = order.fulfilled_at ? new Date(order.fulfilled_at).getTime() : NaN;
        const shipment = shipments[0];
        late.push({
          printifyOrderId: order.id,
          orderName:
            order.metadata?.shop_order_label ||
            order.label ||
            order.external_id ||
            order.id,
          daysSinceOrdered,
          daysSinceShipped: Number.isNaN(fulfilledAt)
            ? null
            : Math.floor((now - fulfilledAt) / DAY_MS),
          status: order.status,
          carrier: shipment?.carrier || null,
          trackingUrl: shipment?.url || null,
          printifyUrl: `https://printify.com/app/orders/${order.id}`,
        });
      }
    }

    if (!batchHadInWindow) done = true; // newest-first: rest is older too
  }

  late.sort((a, b) => b.daysSinceOrdered - a.daysSinceOrdered);

  const payload = {
    thresholdDays,
    count: late.length,
    orders: late,
    cachedAt: new Date(now).toISOString(),
  };
  await cacheSet(cacheKey, payload, CACHE_TTL.LONG); // 30 min
  return NextResponse.json({ ...payload, cached: false });
}
