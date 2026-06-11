/**
 * Printify order relinking
 *
 * Printify has no API to edit an existing order, and once an order is
 * cancelled its native link to the Shopify order is gone (tracking stops
 * syncing). This module implements the workaround:
 *
 *  1. cancel the old Printify order and recreate it via API (e.g. with a
 *     corrected shipping address),
 *  2. remember new-Printify-order -> ORIGINAL-Shopify-order in OrderRelink,
 *  3. when the new Printify order ships (webhook or poll), write the
 *     fulfillment + tracking onto the original Shopify order so the customer
 *     and the store see correct status on the order they actually placed.
 */

import prisma from '@/lib/db';
import { createPrintifyClient, PrintifyClient } from '@/lib/printify';
import type { PrintifyOrder } from '@/lib/printify/types';
import { createShopifyClient } from '@/lib/shopify';
import type { RelinkReason, OrderRelink } from '@prisma/client';

export interface RecreateInput {
  /** Printify order to cancel and recreate */
  printifyOrderId: string;
  /** ORIGINAL Shopify order gid that should keep receiving status */
  shopifyOrderId: string;
  shopifyOrderName?: string;
  reason: RelinkReason;
  /** New shipping address (merged over the original address_to) */
  newAddress?: {
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    country?: string;
    region?: string;
    address1?: string;
    address2?: string;
    city?: string;
    zip?: string;
  };
}

export interface RecreateResult {
  success: boolean;
  newPrintifyOrderId?: string;
  relinkId?: string;
  error?: string;
  /** True when the order is already in production and cannot be cancelled */
  inProduction?: boolean;
}

function compactAddress<T extends Record<string, unknown>>(addr: T): T {
  const out = {} as T;
  for (const key in addr) {
    const value = addr[key];
    if (value !== null && value !== undefined && value !== '') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Cancel a pre-production Printify order and recreate it (new address etc.),
 * recording an OrderRelink so tracking flows back to the original Shopify order.
 */
export async function recreatePrintifyOrder(
  input: RecreateInput
): Promise<RecreateResult> {
  const printifyClient = await createPrintifyClient();
  if (!printifyClient) {
    return { success: false, error: 'Printify not configured' };
  }

  const original = await printifyClient.getOrder(input.printifyOrderId);
  if (!original) {
    return { success: false, error: 'Printify order not found' };
  }

  if (!PrintifyClient.canCancelOrder(original)) {
    return {
      success: false,
      inProduction: true,
      error: 'Printify order is already in production and cannot be cancelled',
    };
  }

  // Build line items from the original order: prefer SKU, fall back to
  // product/variant ids.
  const lineItems = original.line_items.map((li) => {
    const sku = li.sku || li.metadata?.sku;
    if (sku) {
      return { sku, quantity: li.quantity };
    }
    return {
      product_id: li.product_id,
      variant_id: li.variant_id,
      quantity: li.quantity,
    };
  });

  const cancelResult = await printifyClient.cancelOrder(input.printifyOrderId);
  if (!cancelResult.success) {
    return {
      success: false,
      error: `Printify cancel failed: ${cancelResult.error || 'unknown error'}`,
    };
  }

  // external_id must be unique across the shop - suffix with a timestamp
  const baseExternalId =
    original.external_id || input.shopifyOrderName?.replace('#', '') || input.printifyOrderId;
  const externalId = `${baseExternalId}-R${Date.now()}`;

  let newOrder: PrintifyOrder;
  try {
    newOrder = await printifyClient.createOrder({
      external_id: externalId,
      label: input.shopifyOrderName || original.label || undefined,
      address_to: compactAddress({
        ...original.address_to,
        ...(input.newAddress || {}),
      }),
      line_items: lineItems,
      // The original Shopify order keeps notifying the customer; the
      // recreated Printify order must stay silent.
      send_shipping_notification: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      success: false,
      error:
        `Printify order was cancelled but recreation FAILED: ${message}. ` +
        'Create the replacement manually in Printify.',
    };
  }

  // The relink row is the load-bearing artifact - without it, tracking never
  // flows back to the original Shopify order. Write it before any cache
  // bookkeeping, and upsert so a retried action stays idempotent.
  const relink = await prisma.orderRelink.upsert({
    where: { printifyOrderId: newOrder.id },
    create: {
      printifyOrderId: newOrder.id,
      originalPrintifyOrderId: input.printifyOrderId,
      shopifyOrderId: input.shopifyOrderId,
      shopifyOrderName: input.shopifyOrderName || null,
      reason: input.reason,
      status: 'PENDING',
    },
    update: {},
  });

  // POST /orders returns a minimal body (often just the id). Fetch the full
  // order for the cache; fall back to what we already know.
  let cacheOrder = newOrder;
  try {
    const full = await printifyClient.getOrder(newOrder.id);
    if (full) cacheOrder = full;
  } catch {
    // best-effort - the printify-sync loop fills the gap
  }

  // Cache updates are bookkeeping only and must never fail the action
  try {
    await prisma.printifyOrderCache.update({
      where: { id: input.printifyOrderId },
      data: { status: 'cancelled', lastSyncedAt: new Date() },
    });
  } catch {
    // old order may not be cached
  }
  try {
    await prisma.printifyOrderCache.upsert({
      where: { id: newOrder.id },
      create: {
        id: newOrder.id,
        shopId: printifyClient.getShopId(),
        externalId: cacheOrder.external_id || externalId,
        label: cacheOrder.label || input.shopifyOrderName || null,
        metadataShopOrderId: cacheOrder.metadata?.shop_order_id || null,
        metadataShopOrderLabel: cacheOrder.metadata?.shop_order_label || null,
        status: cacheOrder.status || 'pending',
        updatedAt: cacheOrder.updated_at ? new Date(cacheOrder.updated_at) : null,
        data: JSON.parse(JSON.stringify(cacheOrder)),
        lastSyncedAt: new Date(),
      },
      update: {
        status: cacheOrder.status || 'pending',
        data: JSON.parse(JSON.stringify(cacheOrder)),
        lastSyncedAt: new Date(),
      },
    });
  } catch (err) {
    console.error('Relink cache upsert failed (non-fatal):', err);
  }

  return {
    success: true,
    newPrintifyOrderId: newOrder.id,
    relinkId: relink.id,
  };
}

/**
 * Push the shipment of a relinked Printify order onto the original Shopify
 * order as a fulfillment with tracking. Idempotent.
 */
export async function pushFulfillmentForRelink(
  relink: OrderRelink,
  printifyOrder?: PrintifyOrder
): Promise<{ success: boolean; error?: string }> {
  if (relink.status === 'FULFILLED_PUSHED' || relink.status === 'CANCELLED') {
    return { success: true };
  }

  let order = printifyOrder;
  if (!order) {
    const printifyClient = await createPrintifyClient();
    if (!printifyClient) return { success: false, error: 'Printify not configured' };
    order = (await printifyClient.getOrder(relink.printifyOrderId)) || undefined;
  }
  if (!order) return { success: false, error: 'Printify order not found' };

  const shipment = order.shipments?.[0];
  if (!shipment?.number) {
    // Not shipped yet - update production status and wait
    if (order.line_items.some((li) => li.sent_to_production_at) || order.status === 'in-production') {
      await prisma.orderRelink.update({
        where: { id: relink.id },
        data: { status: 'IN_PRODUCTION' },
      });
    }
    return { success: true };
  }

  const shopifyClient = await createShopifyClient();
  if (!shopifyClient) return { success: false, error: 'Shopify not configured' };

  const result = await shopifyClient.createFulfillment(relink.shopifyOrderId, {
    trackingNumber: shipment.number,
    carrier: shipment.carrier,
    trackingUrl: shipment.url,
    notifyCustomer: true,
  });

  if (!result.success) {
    const error = result.errors?.join('; ') || 'Fulfillment push failed';
    await prisma.orderRelink.update({
      where: { id: relink.id },
      data: { status: 'FAILED', error },
    });
    return { success: false, error };
  }

  await prisma.orderRelink.update({
    where: { id: relink.id },
    data: {
      status: 'FULFILLED_PUSHED',
      trackingNumber: shipment.number,
      carrier: shipment.carrier,
      fulfillmentPushedAt: new Date(),
      error: null,
    },
  });

  return { success: true };
}

/**
 * Poll fallback: advance all pending relinks from the Printify order cache
 * (kept fresh by the worker's printify-sync loop) or live API. Makes the
 * webhook an optimization rather than a dependency.
 */
/**
 * Self-heal: recreated Printify orders carry a "-R<timestamp>" external_id
 * marker. If the action crashed after the order was created but before its
 * OrderRelink row was written, tracking would never flow back to the original
 * Shopify order. Detect such orphans from the order cache (filled by the
 * printify-sync loop) and write the missing relink row.
 */
export async function healOrphanedRelinks(): Promise<number> {
  const candidates = await prisma.printifyOrderCache.findMany({
    where: { externalId: { contains: '-R' } },
    select: { id: true, externalId: true, label: true, status: true },
    take: 200,
  });

  let healed = 0;
  for (const c of candidates) {
    if (!c.externalId || !/-R\d+$/.test(c.externalId)) continue;
    // A cancelled recreate was itself replaced - nothing to push for it
    if (c.status === 'cancelled' || c.status === 'canceled') continue;

    const existing = await prisma.orderRelink.findUnique({
      where: { printifyOrderId: c.id },
      select: { id: true },
    });
    if (existing) continue;

    // Resolve the original Shopify order: prefer the label ("#18100"),
    // fall back to the external_id base with all -R suffixes stripped
    let base = c.externalId.replace(/(-R\d+)+$/, '');
    if (c.label?.startsWith('#')) base = c.label.slice(1);
    try {
      const shopify = await createShopifyClient();
      if (!shopify) return healed;
      const order = await shopify.getOrderByNumber(base);
      if (!order) {
        console.warn(
          `[Relink] Orphaned recreate ${c.id} (${c.externalId}): no Shopify order "${base}" found`
        );
        continue;
      }
      await prisma.orderRelink.upsert({
        where: { printifyOrderId: c.id },
        create: {
          printifyOrderId: c.id,
          originalPrintifyOrderId: null,
          shopifyOrderId: order.id,
          shopifyOrderName: order.name,
          reason: 'ADDRESS_CHANGE',
          status: 'PENDING',
        },
        update: {},
      });
      healed++;
      console.log(
        `[Relink] Healed orphaned recreate ${c.id} -> ${order.name} (${c.externalId})`
      );
    } catch (err) {
      console.error(
        `[Relink] Healing ${c.id} failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return healed;
}

export async function processPendingRelinks(): Promise<{
  checked: number;
  pushed: number;
  failed: number;
}> {
  const stats = { checked: 0, pushed: 0, failed: 0 };

  // Recover relink rows lost to mid-action crashes before processing
  try {
    await healOrphanedRelinks();
  } catch (err) {
    console.error('[Relink] Orphan healing pass failed:', err);
  }

  const pending = await prisma.orderRelink.findMany({
    where: { status: { in: ['PENDING', 'IN_PRODUCTION', 'FAILED'] } },
    take: 50,
  });
  if (pending.length === 0) return stats;

  for (const relink of pending) {
    stats.checked++;

    // Prefer the cache (refreshed every 10 min by the worker)
    const cached = await prisma.printifyOrderCache.findUnique({
      where: { id: relink.printifyOrderId },
    });
    const order = cached?.data as unknown as PrintifyOrder | undefined;

    try {
      const result = await pushFulfillmentForRelink(relink, order);
      if (!result.success) {
        stats.failed++;
      } else if (order?.shipments?.[0]?.number) {
        stats.pushed++;
      }
    } catch (err) {
      stats.failed++;
      console.error(
        `[Relink] Error processing ${relink.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return stats;
}

/** Webhook topics we need for relink push-back */
export const RELINK_WEBHOOK_TOPICS = [
  'order:shipment:created',
  'order:shipment:delivered',
];

/**
 * Ensure Printify webhooks are registered for shipment events, pointing at
 * this deployment. Called from worker startup. Returns quietly if APP_URL is
 * not set or Printify is not configured.
 */
export async function ensurePrintifyWebhooks(): Promise<void> {
  const appUrl = process.env.APP_URL;
  if (!appUrl) return;

  const printifyClient = await createPrintifyClient();
  if (!printifyClient) return;

  const secret = process.env.PRINTIFY_WEBHOOK_SECRET;
  const url = `${appUrl.replace(/\/$/, '')}/api/webhooks/printify`;

  try {
    const existing = await printifyClient.listWebhooks();
    for (const topic of RELINK_WEBHOOK_TOPICS) {
      const match = existing.find((w) => w.topic === topic && w.url === url);
      if (!match) {
        await printifyClient.createWebhook({ topic, url, secret });
        console.log(`[Relink] Registered Printify webhook ${topic} -> ${url}`);
      }
    }
  } catch (err) {
    console.error(
      '[Relink] Webhook registration failed (poll fallback still active):',
      err instanceof Error ? err.message : err
    );
  }
}
