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

async function loadCandidates(): Promise<Candidate[]> {
  const rows = await prisma.printifyOrderCache.findMany({
    orderBy: { createdAt: 'desc' },
    take: SCAN_LIMIT,
  });

  return rows.map((row) => {
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
  });
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

  let candidates = await loadCandidates();
  let matches = q ? candidates.filter((c) => c.haystack.includes(q)) : candidates;

  // Cache miss on a real search: a hand-made order created moments ago may not
  // have synced yet. Pull the recent window from Printify once, then re-match.
  let refreshed = false;
  if (q && matches.length === 0) {
    await syncPrintifyOrders({ windowDays: 2 }).catch(() => undefined);
    refreshed = true;
    candidates = await loadCandidates();
    matches = candidates.filter((c) => c.haystack.includes(q));
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
