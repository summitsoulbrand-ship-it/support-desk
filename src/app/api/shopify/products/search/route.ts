/**
 * Shopify product search API with caching
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import { createShopifyClient } from '@/lib/shopify';

// Simple in-memory cache for search results (5 minute TTL)
const searchCache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Clean up old cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of searchCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      searchCache.delete(key);
    }
  }
}, 60 * 1000); // Clean every minute

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
      return NextResponse.json({ products: [] });
    }

    // Check cache first
    const cacheKey = `${search.toLowerCase().trim()}:${limit}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return NextResponse.json({ products: cached.data });
    }

    const client = await createShopifyClient();
    if (!client) {
      return NextResponse.json({ error: 'Shopify not configured' }, { status: 400 });
    }

    const products = await client.searchProducts(search, limit);

    // Cache the results
    searchCache.set(cacheKey, { data: products, timestamp: Date.now() });

    return NextResponse.json({ products });
  } catch (err) {
    console.error('Error searching products:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
