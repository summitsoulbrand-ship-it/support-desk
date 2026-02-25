/**
 * Shopify shipping rates by country
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

    const country = request.nextUrl.searchParams.get('country') || '';
    if (!country) {
      return NextResponse.json({ rates: [] });
    }

    const client = await createShopifyClient();
    if (!client) {
      return NextResponse.json({ error: 'Shopify not configured' }, { status: 400 });
    }

    const result = await client.getShippingRatesForCountry(country);
    return NextResponse.json(result);
  } catch (err) {
    console.error('Error fetching shipping rates:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
