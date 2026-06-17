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
import { createShopifyClient } from '@/lib/shopify';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 90; // last 3 months
const PAGE_SIZE = 50;
const BATCH = 8; // pages fetched in parallel per round
const MAX_PAGES = 120; // hard safety cap against a runaway loop

interface LateOrder {
  printifyOrderId: string;
  externalId: string | null;
  orderName: string;
  daysSinceOrdered: number;
  daysSinceShipped: number | null;
  status: string;
  carrier: string | null;
  trackingUrl: string | null;
  printifyUrl: string;
  // Set when a replacement has already been sent for this order.
  replacement: { via: string; label: string } | null;
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
  // Shopify order id (external_id) -> Printify order ids. >1 means a second
  // Printify order exists for the same Shopify order (a reprint/reorder).
  const byExternalId: Record<string, string[]> = {};

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

        // Track every in-window order by Shopify order id, so a late order can
        // tell whether a second Printify order (reprint) exists for it.
        if (order.external_id) {
          (byExternalId[order.external_id] ||= []).push(order.id);
        }

        const daysSinceOrdered = Math.floor((now - orderedAt) / DAY_MS);
        if (daysSinceOrdered < thresholdDays) continue;

        const shipments = order.shipments || [];
        if (shipments.some((s) => s.delivered_at)) continue; // delivered -> not late

        const fulfilledAt = order.fulfilled_at ? new Date(order.fulfilled_at).getTime() : NaN;
        const shipment = shipments[0];
        late.push({
          printifyOrderId: order.id,
          externalId: order.external_id || null,
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
          printifyUrl: config.shopId
            ? `https://printify.com/app/store/${config.shopId}/order/${order.id}`
            : `https://printify.com/app/orders/${order.id}`,
          replacement: null,
        });
      }
    }

    if (!batchHadInWindow) done = true; // newest-first: rest is older too
  }

  // --- Replacement detection: has a replacement already been sent? ---
  // (1) OrderRelink (support-desk cancel/recreate relinks),
  // (2) Shopify orders tagged "Replacement" whose note references the original,
  // (3) a second Printify order sharing the same Shopify order id (reprint).
  if (late.length > 0) {
    const lateIds = late.map((l) => l.printifyOrderId);
    const lateExt = late.map((l) => l.externalId).filter(Boolean) as string[];
    const lateNames = late.map((l) => l.orderName);

    const relinkByKey = new Map<string, string>();
    try {
      const relinks = await prisma.orderRelink.findMany({
        where: {
          OR: [
            { originalPrintifyOrderId: { in: lateIds } },
            { shopifyOrderId: { in: lateExt } },
            { shopifyOrderName: { in: lateNames } },
          ],
        },
      });
      for (const r of relinks) {
        const label = r.shopifyOrderName
          ? `Replacement ${r.shopifyOrderName}`
          : 'Replacement created';
        if (r.originalPrintifyOrderId) relinkByKey.set(`pid:${r.originalPrintifyOrderId}`, label);
        if (r.shopifyOrderId) relinkByKey.set(`ext:${r.shopifyOrderId}`, label);
        if (r.shopifyOrderName) relinkByKey.set(`name:${r.shopifyOrderName}`, label);
      }
    } catch (err) {
      console.warn('[late-orders] relink lookup failed', err);
    }

    let replacementNotes: string[] = [];
    try {
      const shopify = await createShopifyClient();
      if (shopify) {
        const repls = await shopify.getReplacementOrders(new Date(windowStart).toISOString());
        replacementNotes = repls.map((r) => r.note || '').filter(Boolean);
      }
    } catch (err) {
      console.warn('[late-orders] replacement-order lookup failed', err);
    }

    for (const l of late) {
      const relink =
        relinkByKey.get(`pid:${l.printifyOrderId}`) ||
        (l.externalId ? relinkByKey.get(`ext:${l.externalId}`) : undefined) ||
        relinkByKey.get(`name:${l.orderName}`);
      if (relink) {
        l.replacement = { via: 'relink', label: relink };
      } else if (replacementNotes.some((n) => n.includes(l.orderName))) {
        l.replacement = { via: 'shopify-replacement', label: 'Replacement sent' };
      } else if (l.externalId && (byExternalId[l.externalId]?.length || 0) > 1) {
        l.replacement = { via: 'printify-reprint', label: 'Printify reprint' };
      }
    }
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
