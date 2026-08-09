/**
 * Printify order lookup - search the local Printify order cache so an operator
 * can find a hand-made replacement order (created directly in Printify) and
 * link it back to the original Shopify order via `mark_exchange_handled`.
 *
 * Matches on what the operator actually has in front of them in the Printify
 * dashboard: the display order number (app_order_id), the label, the customer
 * name, or the item title. The internal cache id is resolved for them.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { syncPrintifyOrders } from '@/lib/printify/sync';
import { createPrintifyClient } from '@/lib/printify';
import type { PrintifyOrder } from '@/lib/printify/types';

// A recently hand-made order is, by definition, recent - so a bounded scan of
// the newest cached orders is plenty and keeps the query cheap.
const SCAN_LIMIT = 300;

// Order numbers get pasted with a leading "#", but Printify stores them without
// one - normalize both sides so "#19269685.28650" matches "19269685.28650".
const normalize = (s: string) => s.replace(/#/g, '').trim().toLowerCase();

type Candidate = {
  display: {
    id: string;
    orderNumber: string;
    customerName: string;
    items: string[];
    status: string;
    createdAt: Date;
  };
  haystack: string;
};

type CacheRow = {
  id: string;
  label: string | null;
  externalId: string | null;
  metadataShopOrderLabel: string | null;
  status: string;
  data: unknown;
  createdAt: Date;
};

/**
 * Look an order number straight up in the database, with no recency window.
 *
 * The bounded scan below only sees the newest few hundred cached orders, which
 * at this store's volume is under two days - so a replacement made earlier in
 * the week was reported as "not found" even though it sat in the cache the
 * whole time (Pati, 2026-08-09, Printify #19269685.33582 from Aug 6). The
 * display number lives inside the JSON blob as app_order_id; everything else
 * an operator might paste is an indexed column.
 */
async function findByReference(q: string, limit: number): Promise<CacheRow[]> {
  if (!q) return [];
  return prisma.printifyOrderCache.findMany({
    where: {
      OR: [
        { id: { contains: q, mode: 'insensitive' } },
        { label: { contains: q, mode: 'insensitive' } },
        { externalId: { contains: q, mode: 'insensitive' } },
        { metadataShopOrderId: { contains: q, mode: 'insensitive' } },
        { metadataShopOrderLabel: { contains: q, mode: 'insensitive' } },
        { data: { path: ['app_order_id'], string_contains: q } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/** An order-number-shaped query ("19269685.33582", or a raw cache id). */
const looksLikeOrderNumber = (q: string) => /^[0-9a-f][0-9a-f.\-]{4,}$/i.test(q);

// 12 pages x 50 = the newest 600 Printify orders, roughly a week at this
// store's volume. Only walked on an explicit search that found nothing.
const DEEP_SCAN_PAGES = 12;

/**
 * Last resort: walk Printify's own order list for the number the operator
 * pasted, and cache what we find.
 *
 * The incremental sync only persists orders created inside its window, and a
 * Printify REPRINT is created days after the order it replaces - so a reprint
 * can be missing from the cache entirely, and re-syncing a 2-day window never
 * reaches it (Printify #19269685.33582, created Aug 7, searched Aug 9).
 */
async function deepScanPrintify(q: string): Promise<CacheRow[]> {
  if (!looksLikeOrderNumber(q)) return [];
  try {
    const client = await createPrintifyClient();
    if (!client) return [];
    for (let page = 1; page <= DEEP_SCAN_PAGES; page++) {
      const res = await client.listOrdersPage(page, 50);
      const orders = res.data || [];
      if (orders.length === 0) break;
      const hit = orders.find(
        (o: PrintifyOrder) =>
          normalize(o.app_order_id || '').includes(q) || normalize(o.id || '') === q
      );
      if (hit) {
        const data = JSON.parse(JSON.stringify(hit));
        const payload = {
          externalId: hit.external_id || null,
          label: hit.label || null,
          metadataShopOrderId: hit.metadata?.shop_order_id || null,
          metadataShopOrderLabel: hit.metadata?.shop_order_label || null,
          status: hit.status,
          data,
          lastSyncedAt: new Date(),
        };
        const row = await prisma.printifyOrderCache.upsert({
          where: { id: hit.id },
          create: { id: hit.id, ...payload },
          update: payload,
        });
        return [row];
      }
      if (res.last_page && page >= res.last_page) break;
    }
  } catch (err) {
    console.warn('[printify search] deep scan failed:', err);
  }
  return [];
}

async function loadCandidates(): Promise<Candidate[]> {
  const rows = await prisma.printifyOrderCache.findMany({
    orderBy: { createdAt: 'desc' },
    take: SCAN_LIMIT,
  });

  return rows.map(toCandidate);
}

function toCandidates(rows: CacheRow[]): Candidate[] {
  return rows.map(toCandidate);
}

/** First occurrence wins, so direct order-number hits rank above the scan. */
function dedupe(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter((c) =>
    seen.has(c.display.id) ? false : (seen.add(c.display.id), true)
  );
}

function toCandidate(row: CacheRow): Candidate {
  const data = (row.data as unknown as PrintifyOrder) || null;
  const customerName = data?.address_to
    ? `${data.address_to.first_name || ''} ${data.address_to.last_name || ''}`.trim()
    : '';
  const items = (data?.line_items || [])
    .map((li) => {
      const title = li.metadata?.title || '';
      const variant = li.metadata?.variant_label || '';
      return [title, variant].filter(Boolean).join(' - ');
    })
    .filter(Boolean);
  const orderNumber = data?.app_order_id || row.label || row.id;

  return {
    display: {
      id: row.id,
      orderNumber,
      customerName,
      items,
      status: row.status,
      createdAt: row.createdAt,
    },
    // The text we match the query against (not returned to the client).
    haystack: normalize(
      [
        row.id,
        data?.app_order_id,
        row.label,
        row.externalId,
        row.metadataShopOrderLabel,
        customerName,
        ...items,
      ]
        .filter(Boolean)
        .join(' ')
    ),
  };
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const q = normalize(request.nextUrl.searchParams.get('q') || '');
  const limit = Math.min(
    Number(request.nextUrl.searchParams.get('limit')) || 8,
    25
  );

  // Two passes, because they answer different questions. The direct lookup
  // searches the WHOLE cache for an order number or id (any age); the recent
  // scan is what makes a customer name or design title searchable at all.
  const byReference = q ? toCandidates(await findByReference(q, limit)) : [];
  let candidates = await loadCandidates();
  let matches = q ? candidates.filter((c) => c.haystack.includes(q)) : candidates;
  matches = dedupe([...byReference, ...matches]);

  // Still nothing: an order made moments ago may not have synced yet. Pull the
  // recent window from Printify once, then re-match.
  let refreshed = false;
  if (q && matches.length === 0) {
    await syncPrintifyOrders({ windowDays: 2 }).catch(() => undefined);
    refreshed = true;
    candidates = await loadCandidates();
    matches = dedupe([
      ...toCandidates(await findByReference(q, limit)),
      ...candidates.filter((c) => c.haystack.includes(q)),
    ]);
  }

  // Still nothing, and it looks like an order number: go ask Printify itself.
  if (q && matches.length === 0) {
    matches = toCandidates(await deepScanPrintify(q));
    refreshed = true;
  }

  const filtered = matches.slice(0, limit).map((c) => c.display);

  // Flag any that are already linked, so the UI can warn instead of double-link.
  const linked = await prisma.orderRelink.findMany({
    where: { printifyOrderId: { in: filtered.map((c) => c.id) } },
    select: { printifyOrderId: true, shopifyOrderName: true },
  });
  const linkedMap = new Map(linked.map((l) => [l.printifyOrderId, l.shopifyOrderName]));

  return NextResponse.json({
    refreshed,
    orders: filtered.map((c) => ({
      ...c,
      alreadyLinkedTo: linkedMap.get(c.id) ?? null,
    })),
  });
}
