/**
 * Prisma database client singleton
 * Prevents multiple instances in development due to hot reloading
 */

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Log slow queries in production to help diagnose performance issues
const logConfig = process.env.NODE_ENV === 'development'
  ? ['error', 'warn'] as const
  : ['error', 'warn'] as const; // Enable warnings in prod to catch slow queries

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: [
      ...logConfig,
      { level: 'query', emit: 'event' },
    ],
  });

// Log slow queries. Cross-container network latency on Railway puts almost
// every query at ~280ms, so the threshold sits above that baseline noise
// (override with SLOW_QUERY_MS).
const SLOW_QUERY_MS = parseInt(process.env.SLOW_QUERY_MS || '750', 10);
if (process.env.NODE_ENV === 'production') {
  (prisma.$on as (event: 'query', callback: (e: { query: string; duration: number }) => void) => void)(
    'query',
    (e) => {
      if (e.duration > SLOW_QUERY_MS) {
        console.warn(`Slow query (${e.duration}ms):`, e.query.substring(0, 200));
      }
    }
  );
}

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
