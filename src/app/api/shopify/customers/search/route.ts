/**
 * Shopify customer search API
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import { createShopifyClient } from '@/lib/shopify';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const search = request.nextUrl.searchParams.get('q') || '';
    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '5', 10);

    if (!search) {
      return NextResponse.json({ customers: [] });
    }

    const client = await createShopifyClient();
    if (!client) {
      return NextResponse.json({ error: 'Shopify not configured' }, { status: 400 });
    }

    const customers = await client.searchCustomers(search, limit);
    return NextResponse.json({ customers });
  } catch (err) {
    console.error('Error searching customers:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
