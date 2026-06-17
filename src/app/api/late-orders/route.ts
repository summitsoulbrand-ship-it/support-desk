/**
 * Late orders API
 * Orders not delivered within N days (default 13) of being ordered. Queried LIVE
 * from Printify, which is the only source that actually carries delivery status
 * (Shopify's fulfillment displayStatus stays CONFIRMED and never sees the
 * carrier's delivered event for these POD orders).
 *
 * "Late" = no shipment has a delivered_at AND the order was placed >= N days ago.
 * Each row shows days since it shipped, current status, a tracking link, and a
 * link to the Printify order to escalate.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { PrintifyClient } from '@/lib/printify';
import { PrintifyConfig, PrintifyOrder } from '@/lib/printify/types';
import { decryptJson } from '@/lib/encryption';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PAGES = 12; // ~600 most-recent orders - bounds the API calls
const LOOKBACK_DAYS = 60; // orders older than this are not actionable; stop paging

function shipDate(order: PrintifyOrder): number | null {
  const shipments = order.shipments || [];
  const shippedAts = shipments
    .map((s) => s.shipped_at)
    .filter(Boolean)
    .map((d) => new Date(d as string).getTime())
    .filter((t) => !Number.isNaN(t));
  if (shippedAts.length > 0) return Math.min(...shippedAts);
  if (order.fulfilled_at) {
    const t = new Date(order.fulfilled_at).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return null;
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
  const now = Date.now();

  const settings = await prisma.integrationSettings.findUnique({
    where: { type: 'PRINTIFY' },
  });
  if (!settings || !settings.enabled) {
    return NextResponse.json({ error: 'Printify is not connected' }, { status: 503 });
  }
  const config = decryptJson<PrintifyConfig>(settings.encryptedData);
  const client = new PrintifyClient(config);

  const late: {
    printifyOrderId: string;
    orderName: string;
    daysSinceOrdered: number;
    daysSinceShipped: number | null;
    status: string;
    carrier: string | null;
    trackingUrl: string | null;
    printifyUrl: string;
  }[] = [];

  const oldestRelevant = now - LOOKBACK_DAYS * DAY_MS;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data: orders, last_page } = await client.listOrdersPage(page, 50);
    if (!orders || orders.length === 0) break;

    let allTooOld = true;
    for (const order of orders) {
      const status = (order.status || '').toLowerCase();
      if (status.includes('cancel')) continue;

      const orderedAt = order.created_at ? new Date(order.created_at).getTime() : NaN;
      if (Number.isNaN(orderedAt)) continue;
      if (orderedAt >= oldestRelevant) allTooOld = false;

      // Delivered on any shipment -> not late.
      const shipments = order.shipments || [];
      if (shipments.some((s) => s.delivered_at)) continue;

      const daysSinceOrdered = Math.floor((now - orderedAt) / DAY_MS);
      if (daysSinceOrdered < thresholdDays) continue;
      if (orderedAt < oldestRelevant) continue; // too old to be actionable

      const shipped = shipDate(order);
      const shipment = shipments[0];
      late.push({
        printifyOrderId: order.id,
        orderName:
          order.metadata?.shop_order_label ||
          order.label ||
          order.external_id ||
          order.id,
        daysSinceOrdered,
        daysSinceShipped:
          shipped !== null ? Math.floor((now - shipped) / DAY_MS) : null,
        status: order.status,
        carrier: shipment?.carrier || null,
        trackingUrl: shipment?.url || null,
        printifyUrl: `https://printify.com/app/orders/${order.id}`,
      });
    }

    if (page >= last_page) break;
    if (allTooOld) break; // everything on this page predates the window
  }

  late.sort((a, b) => b.daysSinceOrdered - a.daysSinceOrdered);

  return NextResponse.json({ thresholdDays, count: late.length, orders: late });
}
