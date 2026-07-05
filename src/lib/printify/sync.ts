/**
 * Printify order sync - cache orders locally so the customer sidebar and the
 * /late-orders tab can read production/delivery status without hitting Printify
 * on every render.
 *
 * IMPORTANT: the Printify order-LIST payload (`/shops/{id}/orders.json`) does
 * NOT include an `updated_at` field, and orders are returned newest-CREATED
 * first. The old incremental sync tried to early-stop on "consecutive unchanged
 * pages" by comparing `updated_at` - but since that field is always absent the
 * comparison never matched, the early-stop never fired, and every run degraded
 * into a full ~400-page walk that died partway (timeout / worker wedge),
 * persisting only the newest couple of pages. That left whole months missing
 * from the cache.
 *
 * The fix mirrors the proven /late-orders walk: page newest-first and stop once
 * a page is entirely older than a created-at window. Within the window every
 * order is re-fetched each run, so status / shipment / delivered_at changes stay
 * current; brand-new orders always sit at the top so they are always captured.
 * `fullSync` ignores the window and walks everything (one-time backfill / a
 * daily self-heal that repairs any gap left by downtime).
 */

import { createHash } from 'crypto';
import prisma from '@/lib/db';
import { PrintifyClient, createPrintifyClient } from '@/lib/printify';
import { PrintifyConfig, PrintifyOrder } from '@/lib/printify/types';
import { decryptJson } from '@/lib/encryption';

/**
 * Webhook topics that keep the order cache fresh push-style. Printify fires
 * these the moment an order changes, so the poll sweep is only a safety net
 * for missed deliveries (webhooks are fire-and-forget on Printify's side).
 */
export const ORDER_CACHE_WEBHOOK_TOPICS = [
  'order:created',
  'order:updated',
  'order:sent-to-production',
  'order:shipment:created',
  'order:shipment:delivered',
];

type SyncStats = {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  pages: number;
  stoppedEarly: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
// Fetch this many pages at once (newest-first) to keep wall-clock low and shrink
// the window in which a single hung request could stall the walk.
const PAGE_BATCH = 5;
// Hard cap so a bad last_page can never spin forever.
const MAX_PAGES = 2000;
// Default refresh window for the frequent incremental pass. Made-to-order items
// are produced, shipped, and delivered well within this, so anything older is
// assumed terminal (fulfilled / delivered / canceled) and is left to the daily
// fullSync rather than re-walked every 10 minutes. Brand-new orders always sit
// at the top of the newest-first list, so they are captured regardless of the
// window; gaps older than the window (e.g. left by worker downtime) are healed
// by the fullSync that runs on boot and daily.
const DEFAULT_WINDOW_DAYS = parseInt(
  process.env.PRINTIFY_SYNC_WINDOW_DAYS || '45',
  10
);

type SyncOptions = {
  /** Walk every page regardless of the created-at window (full backfill / self-heal). */
  fullSync?: boolean;
  /** Re-write rows even when the payload is byte-identical to the cache. */
  forceRefresh?: boolean;
  /** Filter by order status (e.g. 'on-hold' for orders not yet sent to production). */
  status?: string;
  /** Override the created-at refresh window (days). Ignored when fullSync is true. */
  windowDays?: number;
};

/** Best-effort "last activity" timestamp for the cache row. The list payload has
 * no updated_at, so we use the most recent of delivered / fulfilled / created. */
function deriveActivityAt(order: PrintifyOrder): Date {
  const candidates: number[] = [];
  const push = (v?: string) => {
    if (!v) return;
    const t = new Date(v).getTime();
    if (!Number.isNaN(t)) candidates.push(t);
  };
  push(order.created_at);
  push(order.fulfilled_at);
  for (const s of order.shipments || []) push(s.delivered_at);
  const ms = candidates.length ? Math.max(...candidates) : Date.now();
  return new Date(ms);
}

function orderCreatedMs(order: PrintifyOrder): number {
  return order.created_at ? new Date(order.created_at).getTime() : NaN;
}

/** Stable hash of just the fields the cache consumers read, so a re-fetch of an
 * unchanged order doesn't churn a write. Covers production status (order +
 * line-item status, sent_to_production_at) and shipment/delivery tracking. */
function contentSignature(order: PrintifyOrder): string {
  const projection = {
    status: order.status,
    fulfilled_at: order.fulfilled_at ?? null,
    line_items: (order.line_items || []).map((li) => ({
      status: li.status,
      sent_to_production_at: li.sent_to_production_at ?? null,
    })),
    shipments: (order.shipments || []).map((s) => ({
      carrier: s.carrier ?? null,
      number: s.number ?? null,
      delivered_at: s.delivered_at ?? null,
    })),
  };
  return createHash('sha1').update(JSON.stringify(projection)).digest('hex');
}

/**
 * Sync Printify orders into the local cache.
 * @param options.fullSync - Walk all pages (default false = stop at the window).
 * @param options.forceRefresh - Re-write rows even if unchanged.
 * @param options.status - Filter by order status.
 * @param options.windowDays - Created-at window for the incremental pass.
 */
export async function syncPrintifyOrders(
  options: SyncOptions | boolean = {}
): Promise<SyncStats> {
  // Support the legacy boolean parameter (true = fullSync).
  const opts = typeof options === 'boolean' ? { fullSync: options } : options;
  const {
    fullSync = false,
    forceRefresh = false,
    status,
    windowDays = DEFAULT_WINDOW_DAYS,
  } = opts;

  const settings = await prisma.integrationSettings.findUnique({
    where: { type: 'PRINTIFY' },
  });

  if (!settings || !settings.enabled) {
    throw new Error('Printify integration not configured');
  }

  const config = decryptJson<PrintifyConfig>(settings.encryptedData);
  const client = new PrintifyClient(config);

  const now = new Date();
  const windowStart = now.getTime() - windowDays * DAY_MS;

  let fetched = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let pagesWalked = 0;
  let stoppedEarly = false;

  let nextPage = 1;
  let lastPage = MAX_PAGES;
  let done = false;

  while (!done && nextPage <= MAX_PAGES && nextPage <= lastPage) {
    // Fetch a batch of pages in parallel (newest-first).
    const pageNums: number[] = [];
    for (let i = 0; i < PAGE_BATCH && nextPage <= MAX_PAGES && nextPage <= lastPage; i++) {
      pageNums.push(nextPage++);
    }

    const responses = await Promise.all(
      pageNums.map((p) => client.listOrdersPage(p, PAGE_SIZE, status))
    );

    // Flatten in page order so the window stop respects newest-first ordering.
    const batchOrders: PrintifyOrder[] = [];
    let batchHadInWindow = false;
    for (const res of responses) {
      if (res.last_page) lastPage = res.last_page;
      const orders = res.data || [];
      pagesWalked += 1;
      fetched += orders.length;
      for (const order of orders) {
        batchOrders.push(order);
        if (!fullSync) {
          const createdMs = orderCreatedMs(order);
          if (!Number.isNaN(createdMs) && createdMs >= windowStart) {
            batchHadInWindow = true;
          }
        }
      }
    }

    if (batchOrders.length === 0) {
      break;
    }

    // Only persist orders inside the window on an incremental pass; fullSync
    // persists everything.
    const toPersist = fullSync
      ? batchOrders
      : batchOrders.filter((o) => {
          const createdMs = orderCreatedMs(o);
          return Number.isNaN(createdMs) || createdMs >= windowStart;
        });

    if (toPersist.length > 0) {
      const ids = toPersist.map((o) => o.id);
      const existing = await prisma.printifyOrderCache.findMany({
        where: { id: { in: ids } },
        select: { id: true, contentHash: true },
      });
      const existingHash = new Map(
        existing.map((row) => [row.id, row.contentHash])
      );

      for (const order of toPersist) {
        const sig = contentSignature(order);

        // Unchanged since last cache: skip the write entirely (the whole point
        // of the incremental pass, since there's no updated_at to diff on).
        if (
          !forceRefresh &&
          existingHash.has(order.id) &&
          existingHash.get(order.id) === sig
        ) {
          skipped += 1;
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
          updatedAt: deriveActivityAt(order),
          data,
          contentHash: sig,
          lastSyncedAt: now,
        };

        if (existingHash.has(order.id)) {
          await prisma.printifyOrderCache.update({
            where: { id: order.id },
            data: payload,
          });
          updated += 1;
        } else {
          await prisma.printifyOrderCache.create({
            data: { id: order.id, ...payload },
          });
          created += 1;
        }
      }
    }

    // Orders that fell outside the window (filtered out of toPersist) also count
    // as skipped for reporting.
    skipped += batchOrders.length - toPersist.length;

    // Newest-first: once a whole batch predates the window, everything below is
    // older too, so we can stop. (fullSync never sets batchHadInWindow.)
    if (!fullSync && !batchHadInWindow) {
      stoppedEarly = true;
      done = true;
    }
  }

  return {
    fetched,
    created,
    updated,
    skipped,
    pages: pagesWalked,
    stoppedEarly,
  };
}

/**
 * Refresh ONE order into the cache - the webhook-driven path. One API call
 * per event, so status changes land in the cache the moment Printify
 * announces them instead of waiting for the next poll sweep. Returns false
 * (never throws) when Printify is unconfigured or the fetch fails; the poll
 * sweep heals whatever this misses.
 */
export async function refreshOrderInCache(orderId: string): Promise<boolean> {
  try {
    const client = await createPrintifyClient();
    if (!client) return false;

    const order = await client.getOrder(orderId);
    if (!order) return false;

    const now = new Date();
    const payload = {
      shopId: client.getShopId() || null,
      externalId: order.external_id || null,
      label: order.label || null,
      metadataShopOrderId: order.metadata?.shop_order_id || null,
      metadataShopOrderLabel: order.metadata?.shop_order_label || null,
      status: order.status,
      updatedAt: deriveActivityAt(order),
      data: JSON.parse(JSON.stringify(order)),
      contentHash: contentSignature(order),
      lastSyncedAt: now,
    };

    await prisma.printifyOrderCache.upsert({
      where: { id: orderId },
      create: { id: orderId, ...payload },
      update: payload,
    });
    return true;
  } catch (err) {
    console.error(
      `[printify-webhook] cache refresh failed for order ${orderId}:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}
