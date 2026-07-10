/**
 * Redis cache utility for caching API responses
 * Falls back gracefully when Redis is unavailable
 */

import Redis from 'ioredis';

// Redis client singleton
let redisClient: Redis | null = null;
let redisAvailable = false;
let connectionAttempted = false;

function getRedisClient(): Redis | null {
  if (redisClient) return redisClient;
  if (connectionAttempted && !redisAvailable) return null;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;

  connectionAttempted = true;

  try {
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => {
        if (times > 3) return null; // Stop retrying after 3 attempts
        return Math.min(times * 100, 1000);
      },
      lazyConnect: true,
      connectTimeout: 5000,
    });

    redisClient.on('connect', () => {
      redisAvailable = true;
      console.log('[Cache] Redis connected');
    });

    redisClient.on('error', (err) => {
      if (redisAvailable) {
        console.warn('[Cache] Redis error:', err.message);
      }
      redisAvailable = false;
    });

    redisClient.on('close', () => {
      redisAvailable = false;
    });

    // Try to connect
    redisClient.connect().catch((err) => {
      console.warn('[Cache] Redis connection failed:', err.message);
      redisAvailable = false;
    });

    return redisClient;
  } catch (err) {
    console.warn('[Cache] Redis init failed:', err);
    return null;
  }
}

// Default TTL values in seconds
export const CACHE_TTL = {
  CUSTOMER_CONTEXT: 5 * 60, // 5 minutes
  SHOPIFY_CUSTOMER: 10 * 60, // 10 minutes
  PRINTIFY_ORDER: 5 * 60, // 5 minutes
  SHORT: 60, // 1 minute
  MEDIUM: 5 * 60, // 5 minutes
  LONG: 30 * 60, // 30 minutes
} as const;

/**
 * Get a cached value
 * @returns The cached value or null if not found/error
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = getRedisClient();
  if (!redis || !redisAvailable) return null;

  try {
    const value = await redis.get(key);
    if (!value) return null;
    return JSON.parse(value) as T;
  } catch (err) {
    console.warn('[Cache] Get error:', err);
    return null;
  }
}

/**
 * Set a cached value
 * @param key Cache key
 * @param value Value to cache (will be JSON stringified)
 * @param ttlSeconds Time to live in seconds
 */
export async function cacheSet<T>(
  key: string,
  value: T,
  ttlSeconds: number = CACHE_TTL.MEDIUM
): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis || !redisAvailable) return false;

  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('[Cache] Set error:', err);
    return false;
  }
}

/**
 * Delete a cached value
 */
export async function cacheDelete(key: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis || !redisAvailable) return false;

  try {
    await redis.del(key);
    return true;
  } catch (err) {
    console.warn('[Cache] Delete error:', err);
    return false;
  }
}

/**
 * Delete all keys matching a pattern
 * Use sparingly as SCAN can be slow on large datasets
 */
export async function cacheDeletePattern(pattern: string): Promise<number> {
  const redis = getRedisClient();
  if (!redis || !redisAvailable) return 0;

  try {
    let cursor = '0';
    let deleted = 0;

    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;

      if (keys.length > 0) {
        await redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== '0');

    return deleted;
  } catch (err) {
    console.warn('[Cache] Delete pattern error:', err);
    return 0;
  }
}

/**
 * Cache key generators for consistent naming
 */
export const cacheKey = {
  customerContext: (email: string) => `ctx:customer:${email.toLowerCase()}`,
  shopifyCustomer: (email: string) => `shopify:customer:${email.toLowerCase()}`,
  printifyOrder: (orderId: string) => `printify:order:${orderId}`,
  threadContext: (threadId: string) => `ctx:thread:${threadId}`,
  // ONE place for the late-orders list key. The version once lived inline in
  // each file: a v1->v2 bump in the list route left the resolve/recovery
  // busters clearing v1 while the page cached v2, so operator ticks looked
  // unsaved for up to 30 min (2026-07-08).
  // v3: rows carry handledAt + printifyRecovery note/ticketUrl.
  lateOrders: (thresholdDays: number | string) => `late-orders:v3:${thresholdDays}`,
} as const;

/** Version-proof pattern matching every late-orders list key - use for busts. */
export const LATE_ORDERS_CACHE_PATTERN = 'late-orders:*';

/**
 * Check if Redis cache is available
 */
export function isCacheAvailable(): boolean {
  getRedisClient(); // Ensure connection is attempted
  return redisAvailable;
}
