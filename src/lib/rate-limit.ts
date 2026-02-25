/**
 * Rate limiter with Redis support for distributed deployments
 * Falls back to in-memory store for local development
 */

import Redis from 'ioredis';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory store for fallback
const memoryStore = new Map<string, RateLimitEntry>();

// Redis client (lazy initialized)
let redisClient: Redis | null = null;
let redisAvailable = false;

function getRedisClient(): Redis | null {
  if (redisClient) return redisClient;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;

  try {
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // Don't retry, fall back to memory
      lazyConnect: true,
    });

    redisClient.on('connect', () => {
      redisAvailable = true;
    });

    redisClient.on('error', () => {
      redisAvailable = false;
    });

    // Try to connect
    redisClient.connect().catch(() => {
      redisAvailable = false;
    });

    return redisClient;
  } catch {
    return null;
  }
}

// Clean up old entries in memory store every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryStore.entries()) {
    if (entry.resetAt < now) {
      memoryStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetIn: number; // seconds
}

/**
 * Check rate limit for a given identifier (e.g., IP address or email)
 * Uses Redis in production, falls back to in-memory for local dev
 * @param identifier - Unique identifier for the rate limit (IP or email)
 * @param limit - Maximum number of attempts
 * @param windowMs - Time window in milliseconds
 */
export async function checkRateLimitAsync(
  identifier: string,
  limit: number = 5,
  windowMs: number = 15 * 60 * 1000 // 15 minutes
): Promise<RateLimitResult> {
  const redis = getRedisClient();
  const key = `ratelimit:${identifier}`;

  if (redis && redisAvailable) {
    try {
      const now = Date.now();
      const windowSec = Math.ceil(windowMs / 1000);

      // Use Redis transaction for atomic operation
      const multi = redis.multi();
      multi.incr(key);
      multi.ttl(key);
      const results = await multi.exec();

      if (!results) {
        throw new Error('Redis transaction failed');
      }

      const count = results[0][1] as number;
      let ttl = results[1][1] as number;

      // If this is a new key, set expiry
      if (ttl === -1) {
        await redis.expire(key, windowSec);
        ttl = windowSec;
      }

      if (count > limit) {
        return {
          success: false,
          remaining: 0,
          resetIn: ttl,
        };
      }

      return {
        success: true,
        remaining: limit - count,
        resetIn: ttl,
      };
    } catch {
      // Fall through to memory store
      redisAvailable = false;
    }
  }

  // In-memory fallback
  return checkRateLimitMemory(identifier, limit, windowMs);
}

/**
 * Synchronous rate limit check (uses memory store only)
 * Kept for backward compatibility with existing code
 */
export function checkRateLimit(
  identifier: string,
  limit: number = 5,
  windowMs: number = 15 * 60 * 1000
): RateLimitResult {
  return checkRateLimitMemory(identifier, limit, windowMs);
}

function checkRateLimitMemory(
  identifier: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  const entry = memoryStore.get(identifier);

  if (!entry || entry.resetAt < now) {
    // First attempt or window expired
    memoryStore.set(identifier, {
      count: 1,
      resetAt: now + windowMs,
    });
    return {
      success: true,
      remaining: limit - 1,
      resetIn: Math.ceil(windowMs / 1000),
    };
  }

  if (entry.count >= limit) {
    // Rate limit exceeded
    return {
      success: false,
      remaining: 0,
      resetIn: Math.ceil((entry.resetAt - now) / 1000),
    };
  }

  // Increment counter
  entry.count++;
  return {
    success: true,
    remaining: limit - entry.count,
    resetIn: Math.ceil((entry.resetAt - now) / 1000),
  };
}

/**
 * Reset rate limit for an identifier (call on successful login)
 */
export async function resetRateLimitAsync(identifier: string): Promise<void> {
  const redis = getRedisClient();
  const key = `ratelimit:${identifier}`;

  if (redis && redisAvailable) {
    try {
      await redis.del(key);
    } catch {
      // Fall through to memory store
    }
  }

  memoryStore.delete(identifier);
}

/**
 * Synchronous reset (memory store only)
 * Kept for backward compatibility
 */
export function resetRateLimit(identifier: string): void {
  memoryStore.delete(identifier);
}
