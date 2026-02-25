/**
 * Printify sync API - cache all orders locally
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { syncPrintifyOrders } from '@/lib/printify/sync';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'MANAGE_INTEGRATIONS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const stats = await prisma.printifyOrderCache.aggregate({
      _count: { id: true },
      _max: { lastSyncedAt: true },
    });

    return NextResponse.json({
      totalOrders: stats._count.id,
      lastSyncedAt: stats._max.lastSyncedAt,
    });
  } catch (err) {
    console.error('Error fetching Printify sync status:', err);
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

    // Allow any authenticated user to trigger sync (for background auto-sync)
    // The sync itself is read-only and just caches order data

    // Support full sync and force refresh via query params or request body
    const body = await request.json().catch(() => ({}));
    const fullSync =
      request.nextUrl.searchParams.get('full') === '1' || body.fullSync === true;
    const forceRefresh =
      request.nextUrl.searchParams.get('force') === '1' || body.forceRefresh === true;

    const result = await syncPrintifyOrders({ fullSync, forceRefresh })
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error('Error syncing Printify orders:', err);
    return NextResponse.json(
      { error: 'Sync failed', details: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
