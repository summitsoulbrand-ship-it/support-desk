/**
 * Printify order sync - cache orders locally with incremental sync support
 */

import prisma from '@/lib/db';
import { PrintifyClient } from '@/lib/printify';
import { PrintifyConfig, PrintifyOrder } from '@/lib/printify/types';
import { decryptJson } from '@/lib/encryption';

type SyncStats = {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  pages: number;
  stoppedEarly: boolean;
};

function parseUpdatedAt(order: PrintifyOrder): Date | null {
  if (!order.updated_at) return null;
  const parsed = new Date(order.updated_at);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

type SyncOptions = {
  fullSync?: boolean;
  forceRefresh?: boolean;
  /** Filter by order status (e.g., 'on-hold' for orders not yet sent to production) */
  status?: string;
};

/**
 * Sync Printify orders with incremental support
 * @param options.fullSync - If true, fetches all pages. If false (default), stops when finding unchanged orders.
 * @param options.forceRefresh - If true, re-fetches all order data regardless of timestamps.
 * @param options.status - Filter by order status (e.g., 'on-hold' for orders not yet sent to production).
 */
export async function syncPrintifyOrders(options: SyncOptions | boolean = {}): Promise<SyncStats> {
  // Support legacy boolean parameter
  const opts = typeof options === 'boolean' ? { fullSync: options } : options;
  const { fullSync = false, forceRefresh = false, status } = opts;
  const settings = await prisma.integrationSettings.findUnique({
    where: { type: 'PRINTIFY' },
  });

  if (!settings || !settings.enabled) {
    throw new Error('Printify integration not configured');
  }

  const config = decryptJson<PrintifyConfig>(settings.encryptedData);
  const client = new PrintifyClient(config);

  const now = new Date();
  let page = 1;
  let lastPage = 1;
  let fetched = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let stoppedEarly = false;
  let consecutiveUnchangedPages = 0;

  do {
    const response = await client.listOrdersPage(page, 50, status);
    const orders = response.data || [];
    lastPage = response.last_page || page;
    fetched += orders.length;

    if (orders.length === 0) {
      break;
    }

    const ids = orders.map((o) => o.id);
    const existing = await prisma.printifyOrderCache.findMany({
      where: { id: { in: ids } },
      select: { id: true, updatedAt: true },
    });
    const existingMap = new Map(
      existing.map((row) => [row.id, row.updatedAt])
    );

    let pageSkipped = 0;
    let pageUpdated = 0;
    let pageCreated = 0;

    for (const order of orders) {
      const orderUpdatedAt = parseUpdatedAt(order);
      const cachedUpdatedAt = existingMap.get(order.id) || null;
      const isSame =
        !forceRefresh &&
        orderUpdatedAt &&
        cachedUpdatedAt &&
        orderUpdatedAt.getTime() === cachedUpdatedAt.getTime();

      if (isSame) {
        skipped += 1;
        pageSkipped += 1;
        continue;
      }

      const data = JSON.parse(JSON.stringify(order));

      const payload = {
        shopId: config.shopId || null,
        externalId: order.external_id || null,
        label: order.label || null,
        metadataShopOrderId: order.metadata?.shop_order_id || null,
        metadataShopOrderLabel: order.metadata?.shop_order_label || null,
        status: order.status,
        updatedAt: orderUpdatedAt,
        data,
        lastSyncedAt: now,
      };

      if (existingMap.has(order.id)) {
        await prisma.printifyOrderCache.update({
          where: { id: order.id },
          data: payload,
        });
        updated += 1;
        pageUpdated += 1;
      } else {
        await prisma.printifyOrderCache.create({
          data: {
            id: order.id,
            ...payload,
          },
        });
        created += 1;
        pageCreated += 1;
      }
    }

    // For incremental sync: stop if we've seen 2 consecutive pages with no changes
    // This handles the case where Printify returns orders sorted by updated_at desc
    if (!fullSync) {
      if (pageUpdated === 0 && pageCreated === 0) {
        consecutiveUnchangedPages += 1;
        if (consecutiveUnchangedPages >= 2) {
          stoppedEarly = true;
          break;
        }
      } else {
        consecutiveUnchangedPages = 0;
      }
    }

    page += 1;
  } while (page <= lastPage);

  return { fetched, created, updated, skipped, pages: page - 1, stoppedEarly };
}
