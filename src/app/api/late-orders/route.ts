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
  // Set when Shopify shows the order was (partially) refunded.
  refund: { label: string; amount: number } | null;
  fp: string | null; // internal: customer+address+SKU fingerprint
  shopOrderId: string | null; // internal: Shopify numeric order id for refund lookup
}

/**
 * Fingerprint a Printify order by who/where/what: customer name + zip + the
 * sorted set of SKUs. A Printify reprint is a separate (manual) order with the
 * SAME fingerprint as the original (same shirt, same customer, same address) -
 * which is the only link, since reprints carry no reference field in the API.
 */
function fingerprint(order: PrintifyOrder): string | null {
  const a = order.address_to || ({} as PrintifyOrder['address_to']);
  const name = `${a.first_name || ''} ${a.last_name || ''}`.trim().toLowerCase();
  const zip = (a.zip || '').replace(/\s/g, '').toLowerCase();
  const skus = (order.line_items || [])
    .map((li) => li.metadata?.sku || String(li.variant_id || ''))
    .filter(Boolean)
    .sort()
    .join(',');
  if (!name || !zip || !skus) return null;
  return `${name}|${zip}|${skus}`;
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
  // fingerprint -> the orders sharing it (to spot reprints: a manual order with
  // the same customer/address/SKU as a late one).
  const byFingerprint: Record<string, { id: string; orderType: string }[]> = {};

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

        // Record the fingerprint of EVERY in-window order (incl. reprints and
        // delivered ones) so a late order can find its reprint sibling below.
        const fp = fingerprint(order);
        if (fp) {
          (byFingerprint[fp] ||= []).push({
            id: order.id,
            orderType: order.metadata?.order_type || '',
          });
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
          refund: null,
          fp,
          shopOrderId: order.metadata?.shop_order_id || null,
        });
      }
    }

    if (!batchHadInWindow) done = true; // newest-first: rest is older too
  }

  // --- Replacement detection: has a replacement already been sent? ---
  // Reliable signals only:
  //  (1) A Shopify order tagged "Replacement" whose note references the original
  //      (e.g. "Replacement order for #20205 - lost"). Catches replacements
  //      created via the support desk.
  //  (2) OrderRelink (support-desk cancel/recreate relinks), matched by order name.
  // NOTE: Printify-direct reships create NO linkable record (no shared
  // external_id / shop_order_id, no Shopify order), so they cannot be detected.
  const digitsOf = (s: string | null | undefined) => (s || '').replace(/\D/g, '');

  if (late.length > 0) {
    const lateNames = late.map((l) => l.orderName);

    // (2) relinks, keyed by the original order-number digits + printify id
    const relinkByDigits = new Map<string, string>();
    const relinkByPid = new Map<string, string>();
    try {
      const relinks = await prisma.orderRelink.findMany({
        where: {
          OR: [
            { originalPrintifyOrderId: { in: late.map((l) => l.printifyOrderId) } },
            { shopifyOrderName: { in: lateNames } },
          ],
        },
      });
      for (const r of relinks) {
        const label = r.shopifyOrderName ? `Replacement ${r.shopifyOrderName}` : 'Replacement created';
        if (r.shopifyOrderName) relinkByDigits.set(digitsOf(r.shopifyOrderName), label);
        if (r.originalPrintifyOrderId) relinkByPid.set(r.originalPrintifyOrderId, label);
      }
    } catch (err) {
      console.warn('[late-orders] relink lookup failed', err);
    }

    // (1) Shopify Replacement orders -> the order-number digits they reference
    const replacedDigits = new Set<string>();
    try {
      const shopify = await createShopifyClient();
      if (shopify) {
        const repls = await shopify.getReplacementOrders(new Date(windowStart).toISOString());
        for (const r of repls) {
          const m = (r.note || '').match(/for\s+#?(\d{3,})/i);
          if (m) replacedDigits.add(m[1]);
        }
      }
    } catch (err) {
      console.warn('[late-orders] replacement-order lookup failed', err);
    }

    for (const l of late) {
      const d = digitsOf(l.orderName);
      const relink = relinkByPid.get(l.printifyOrderId) || relinkByDigits.get(d);
      // A Printify reprint: a separate MANUAL order with the same fingerprint
      // (same customer, address, and shirt) as this late order.
      const reprint =
        l.fp &&
        (byFingerprint[l.fp] || []).some(
          (o) => o.id !== l.printifyOrderId && o.orderType === 'manual'
        );
      if (relink) {
        l.replacement = { via: 'relink', label: relink };
      } else if (d && replacedDigits.has(d)) {
        l.replacement = { via: 'shopify-replacement', label: 'Replacement sent' };
      } else if (reprint) {
        l.replacement = { via: 'printify-reprint', label: 'Reprint sent' };
      }
    }

    // --- Refund status: match to Shopify and flag orders already refunded ---
    try {
      const shopify = await createShopifyClient();
      const shopIds = late.map((l) => l.shopOrderId).filter(Boolean) as string[];
      if (shopify && shopIds.length > 0) {
        const refundMap = await shopify.getOrdersRefundStatus(shopIds);
        for (const l of late) {
          const r = l.shopOrderId ? refundMap[l.shopOrderId] : undefined;
          if (!r) continue;
          const fs = (r.financialStatus || '').toUpperCase();
          if (fs === 'REFUNDED' || (fs === 'PARTIALLY_REFUNDED' && r.totalRefunded > 0) || r.totalRefunded > 0) {
            l.refund = {
              label: fs === 'REFUNDED' ? 'Refunded' : 'Partial refund',
              amount: r.totalRefunded,
            };
          }
        }
      }
    } catch (err) {
      console.warn('[late-orders] refund lookup failed', err);
    }
  }

  late.sort((a, b) => b.daysSinceOrdered - a.daysSinceOrdered);

  const payload = {
    thresholdDays,
    count: late.length,
    // Drop internal fields (fingerprint has customer data; shopOrderId is internal).
    orders: late.map(({ fp: _fp, shopOrderId: _sid, ...rest }) => rest),
    cachedAt: new Date(now).toISOString(),
  };
  await cacheSet(cacheKey, payload, CACHE_TTL.LONG); // 30 min
  return NextResponse.json({ ...payload, cached: false });
}
