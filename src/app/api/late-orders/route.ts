/**
 * Late orders API
 * Orders that shipped but have not been delivered within N days (default 13),
 * read from the Printify order cache (kept fresh by the worker). Each row gives
 * the days since it shipped, current status, a Printify tracking link, and a
 * link to the Printify order so it can be escalated to Printify.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import type { PrintifyOrder } from '@/lib/printify/types';

const DAY_MS = 24 * 60 * 60 * 1000;

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

  // Recent synced Printify orders (the cache the worker keeps fresh). 1000 rows
  // covers well beyond the 13-45 day window we care about.
  const rows = await prisma.printifyOrderCache.findMany({
    where: { status: { notIn: ['canceled', 'cancelled'] } },
    orderBy: { updatedAt: 'desc' },
    take: 1000,
  });

  const late: {
    printifyOrderId: string;
    orderName: string;
    daysSinceShipped: number;
    status: string;
    carrier: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    printifyUrl: string;
  }[] = [];

  for (const row of rows) {
    const order = row.data as unknown as PrintifyOrder;
    const shipments = order?.shipments || [];
    if (shipments.length === 0) continue; // not shipped yet

    // Delivered on any shipment -> not late.
    if (shipments.some((s) => s.delivered_at)) continue;

    const shippedAts = shipments
      .map((s) => s.shipped_at)
      .filter(Boolean)
      .map((d) => new Date(d as string).getTime())
      .filter((t) => !Number.isNaN(t));
    if (shippedAts.length === 0) continue; // label exists but no ship date

    const earliestShipped = Math.min(...shippedAts);
    const daysSinceShipped = Math.floor((now - earliestShipped) / DAY_MS);
    if (daysSinceShipped < thresholdDays) continue;

    const shipment = shipments[0];
    late.push({
      printifyOrderId: order.id,
      orderName:
        row.metadataShopOrderLabel ||
        row.label ||
        order.external_id ||
        order.id,
      daysSinceShipped,
      status: order.status,
      carrier: shipment.carrier || null,
      trackingNumber: shipment.number || null,
      trackingUrl: shipment.url || null,
      printifyUrl: `https://printify.com/app/orders/${order.id}`,
    });
  }

  late.sort((a, b) => b.daysSinceShipped - a.daysSinceShipped);

  return NextResponse.json({ thresholdDays, count: late.length, orders: late });
}
