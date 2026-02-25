/**
 * Order Link Sync API - creates OrderLink records for Shopify orders with Printify matches
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { createShopifyClient } from '@/lib/shopify';
import { PrintifyClient, type PrintifyOrder } from '@/lib/printify';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'MANAGE_INTEGRATIONS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const stats = await prisma.orderLink.aggregate({
      _count: { id: true },
      _max: { lastSyncAt: true },
    });

    return NextResponse.json({
      totalLinks: stats._count.id,
      lastSyncedAt: stats._max.lastSyncAt,
    });
  } catch (err) {
    console.error('Error fetching order sync status:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const shopifyClient = await createShopifyClient();
    if (!shopifyClient) {
      return NextResponse.json(
        { error: 'Shopify integration not configured' },
        { status: 400 }
      );
    }

    // Check if Printify cache exists
    const printifyCacheCount = await prisma.printifyOrderCache.count();
    if (printifyCacheCount === 0) {
      return NextResponse.json(
        { error: 'Printify cache is empty. Run Printify sync first.' },
        { status: 400 }
      );
    }

    // Get limit from query params (default 100)
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);

    // Fetch recent Shopify orders
    const orders = await shopifyClient.getOrdersByQuery('', limit);

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let noMatch = 0;

    for (const order of orders) {
      // Try to find matching Printify order
      const orderName = order.name;
      const orderNumber = order.name.replace('#', '');
      const legacyId = order.legacyResourceId;
      const candidates = [orderName, orderNumber, legacyId];

      const match = await prisma.printifyOrderCache.findFirst({
        where: {
          OR: [
            { externalId: { in: candidates } },
            { label: { in: candidates } },
            { metadataShopOrderId: { in: candidates } },
            { metadataShopOrderLabel: { in: candidates } },
          ],
        },
      });

      if (!match) {
        noMatch++;
        continue;
      }

      const orderData = match.data as unknown as PrintifyOrder;
      const productionStatus = PrintifyClient.getProductionStatus(orderData);

      // Check if link exists
      const existingLink = await prisma.orderLink.findUnique({
        where: { shopifyOrderId: order.id },
      });

      if (existingLink) {
        // Update existing link
        await prisma.orderLink.update({
          where: { shopifyOrderId: order.id },
          data: {
            printifyOrderId: match.id,
            shopifyData: JSON.parse(JSON.stringify(order)),
            printifyData: JSON.parse(JSON.stringify(orderData)),
            lastSyncAt: new Date(),
          },
        });
        updated++;
      } else {
        // Create new link
        await prisma.orderLink.create({
          data: {
            shopifyOrderId: order.id,
            shopifyOrderNumber: order.name,
            printifyOrderId: match.id,
            matchMethod: 'ORDER_NUMBER' as never,
            matchConfidence: 0.9,
            shopifyData: JSON.parse(JSON.stringify(order)),
            printifyData: JSON.parse(JSON.stringify(orderData)),
            lastSyncAt: new Date(),
          },
        });
        created++;
      }
    }

    skipped = updated; // Renamed for clarity

    return NextResponse.json({
      success: true,
      processed: orders.length,
      created,
      updated,
      noMatch,
    });
  } catch (err) {
    console.error('Error syncing order links:', err);
    return NextResponse.json(
      { error: 'Sync failed', details: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
