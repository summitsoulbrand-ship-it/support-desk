/**
 * Background tracking refresh
 * Keeps trackingCache warm for shipments tied to open threads so the UI and
 * AI drafts always have recent carrier status without on-click fetching.
 */

import prisma from '@/lib/db';
import { createTrackingMoreClient } from '@/lib/trackingmore';
import type { TrackingResult } from '@/lib/trackingmore';
import type { PrintifyOrder } from '@/lib/printify/types';

const DEFAULT_TTL_HOURS = parseFloat(process.env.TRACKING_TTL_HOURS || '4');
const MAX_REFRESHES_PER_RUN = parseInt(process.env.TRACKING_MAX_PER_RUN || '15', 10);

export interface TrackingRefreshStats {
  candidates: number;
  refreshed: number;
  errors: number;
}

/**
 * Refresh stale tracking cache entries for shipments belonging to customers
 * with OPEN/PENDING threads. Delivered shipments are never re-fetched.
 */
export async function refreshTrackingForOpenThreads(): Promise<TrackingRefreshStats> {
  const stats: TrackingRefreshStats = { candidates: 0, refreshed: 0, errors: 0 };

  // Quota discipline (TrackingMore is metered): only warm tracking for
  // threads where shipping status actually matters to the reply
  const openThreads = await prisma.thread.findMany({
    where: {
      status: { in: ['OPEN', 'PENDING'] },
      triage: { intent: { in: ['SHIPPING_STATUS', 'ORDER_ISSUE'] } },
    },
    select: { customerEmail: true },
  });

  const emails = [...new Set(
    openThreads
      .map((t) => t.customerEmail?.toLowerCase())
      .filter((e): e is string => !!e)
  )];
  if (emails.length === 0) return stats;

  // Recent Printify cached orders; customer email lives inside the order JSON
  // (address_to.email), so filter in JS against the open-thread emails.
  const emailSet = new Set(emails);
  const printifyOrders = await prisma.printifyOrderCache.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 300,
  });

  // Collect unique shipments
  const shipments = new Map<string, { trackingNumber: string; carrier: string }>();
  for (const cached of printifyOrders) {
    const order = cached.data as unknown as PrintifyOrder;
    const orderEmail = order?.address_to?.email?.toLowerCase();
    if (!orderEmail || !emailSet.has(orderEmail)) continue;
    for (const shipment of order?.shipments || []) {
      if (shipment.number && shipment.carrier) {
        shipments.set(`${shipment.number}|${shipment.carrier}`, {
          trackingNumber: shipment.number,
          carrier: shipment.carrier,
        });
      }
    }
  }
  if (shipments.size === 0) return stats;

  const cutoff = new Date(Date.now() - DEFAULT_TTL_HOURS * 60 * 60 * 1000);
  let client = null;

  for (const { trackingNumber, carrier } of shipments.values()) {
    if (stats.refreshed >= MAX_REFRESHES_PER_RUN) break;

    const cached = await prisma.trackingCache.findUnique({
      where: { trackingNumber_carrier: { trackingNumber, carrier } },
    });

    // Fresh enough or already delivered: skip
    if (cached) {
      const data = cached.data as unknown as TrackingResult;
      if (data?.status === 'delivered' || data?.status === 'expired') continue;
      if (cached.fetchedAt > cutoff) continue;
    }

    stats.candidates++;

    try {
      if (!client) {
        client = await createTrackingMoreClient();
        if (!client) return stats; // not configured
      }

      const result = await client.trackShipment(trackingNumber, carrier);

      await prisma.trackingCache.upsert({
        where: { trackingNumber_carrier: { trackingNumber, carrier } },
        create: {
          trackingNumber,
          carrier,
          data: result as object,
          fetchedAt: new Date(),
        },
        update: {
          data: result as object,
          fetchedAt: new Date(),
        },
      });
      stats.refreshed++;
    } catch (err) {
      stats.errors++;
      console.error(
        `[TrackingRefresh] Failed for ${carrier} ${trackingNumber}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return stats;
}
