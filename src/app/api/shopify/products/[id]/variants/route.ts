/**
 * Shopify product variants API with caching
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import { createShopifyClient } from '@/lib/shopify';

type RouteContext = {
  params: Promise<{ id: string }>;
};

// Simple in-memory cache for variants (10 minute TTL - variants change less frequently)
const variantsCache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Clean up old cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of variantsCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      variantsCache.delete(key);
    }
  }
}, 60 * 1000); // Clean every minute

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;

    // Check cache first
    const cached = variantsCache.get(id);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return NextResponse.json(cached.data);
    }

    const client = await createShopifyClient();
    if (!client) {
      return NextResponse.json({ error: 'Shopify not configured' }, { status: 400 });
    }

    const data = await client.getProductVariants(id, 250);
    if (!data) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    // Cache the results
    variantsCache.set(id, { data, timestamp: Date.now() });

    return NextResponse.json(data);
  } catch (err) {
    console.error('Error fetching product variants:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
