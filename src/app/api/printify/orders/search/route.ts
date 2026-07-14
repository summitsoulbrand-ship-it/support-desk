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
import type { PrintifyOrder } from '@/lib/printify/types';

// A recently hand-made order is, by definition, recent - so a bounded scan of
// the newest cached orders is plenty and keeps the query cheap.
const SCAN_LIMIT = 300;

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const q = (request.nextUrl.searchParams.get('q') || '').trim().toLowerCase();
  const limit = Math.min(
    Number(request.nextUrl.searchParams.get('limit')) || 8,
    25
  );

  const rows = await prisma.printifyOrderCache.findMany({
    orderBy: { createdAt: 'desc' },
    take: SCAN_LIMIT,
  });

  const candidates = rows.map((row) => {
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

    const display = {
      id: row.id,
      orderNumber,
      customerName,
      items,
      status: row.status,
      createdAt: row.createdAt,
    };
    // The text we match the query against (not returned to the client).
    const haystack = [
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
      .toLowerCase();
    return { display, haystack };
  });

  const filtered = (q ? candidates.filter((c) => c.haystack.includes(q)) : candidates)
    .slice(0, limit)
    .map((c) => c.display);

  // Flag any that are already linked, so the UI can warn instead of double-link.
  const linked = await prisma.orderRelink.findMany({
    where: { printifyOrderId: { in: filtered.map((c) => c.id) } },
    select: { printifyOrderId: true, shopifyOrderName: true },
  });
  const linkedMap = new Map(linked.map((l) => [l.printifyOrderId, l.shopifyOrderName]));

  return NextResponse.json({
    orders: filtered.map((c) => ({
      ...c,
      alreadyLinkedTo: linkedMap.get(c.id) ?? null,
    })),
  });
}
