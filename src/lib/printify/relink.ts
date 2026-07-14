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
import { ORDER_CACHE_WEBHOOK_TOPICS } from '@/lib/printify/sync';
import type { PrintifyOrder, PrintifyProduct } from '@/lib/printify/types';
import { createShopifyClient } from '@/lib/shopify';
import type { RelinkReason, OrderRelink } from '@prisma/client';

export interface RecreateInput {
  /** Printify order to cancel and recreate */
  printifyOrderId: string;
  /** ORIGINAL Shopify order gid that should keep receiving status */
  shopifyOrderId: string;
  shopifyOrderName?: string;
  reason: RelinkReason;
  /**
   * Replacement line items for the new Printify order. When omitted, the
   * original order's items are copied (e.g. an address-only change). Provide
   * this to CHANGE the item (size/color/product) before production.
   */
  lineItems?: {
    sku?: string;
    product_id?: string;
    variant_id?: number;
    quantity: number;
    /**
     * Human-readable variant label (e.g. "Blue Jean / L") shared by Shopify and
     * Printify. When present, the recreate resolves this to Printify's own
     * product_id + variant_id off the original order's product - far more
     * reliable than a Shopify SKU that may not match Printify's.
     */
    variantLabel?: string;
    /**
     * The PRODUCT the line belongs to (Shopify line title, e.g. "Wanderlust
     * Love"). Every tee shares the same color/size matrix, so a bare variant
     * label matches EVERY product on the order - without this affinity a
     * multi-item change resolved to the first product tried and printed the
     * wrong design (#27253, 2026-07-10: Wanderlust M became a second Owl).
     */
    itemTitle?: string;
  }[];
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

// Printify's GET order returns the country as a full English NAME ("United
// States"), but POST /orders requires an ISO 3166-1 alpha-2 CODE ("US").
// Copying the read address straight back into a create makes Printify reject
// it with an opaque 500. Convert the name to a code (pass through if it's
// already a 2-letter code). Covers Summit Soul's markets; unknown names fall
// through unchanged as a best effort.
const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  'united states': 'US',
  usa: 'US',
  'united states of america': 'US',
  canada: 'CA',
  'united kingdom': 'GB',
  'great britain': 'GB',
  australia: 'AU',
  'new zealand': 'NZ',
  ireland: 'IE',
  germany: 'DE',
  france: 'FR',
  italy: 'IT',
  spain: 'ES',
  netherlands: 'NL',
  belgium: 'BE',
  austria: 'AT',
  sweden: 'SE',
  denmark: 'DK',
  finland: 'FI',
  poland: 'PL',
  portugal: 'PT',
  greece: 'GR',
  czechia: 'CZ',
  'czech republic': 'CZ',
  hungary: 'HU',
  romania: 'RO',
  bulgaria: 'BG',
  croatia: 'HR',
  slovakia: 'SK',
  slovenia: 'SI',
  lithuania: 'LT',
  latvia: 'LV',
  estonia: 'EE',
  luxembourg: 'LU',
  malta: 'MT',
  cyprus: 'CY',
  switzerland: 'CH',
  norway: 'NO',
  japan: 'JP',
  mexico: 'MX',
};

export function toCountryCode(country?: string): string | undefined {
  if (!country) return country;
  const trimmed = country.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return COUNTRY_NAME_TO_CODE[trimmed.toLowerCase()] || trimmed;
}

/**
 * Variant labels as an unordered, normalized token set so "Blue Jean / L" and
 * "L / Blue Jean" compare equal (Shopify and Printify can order options
 * differently).
 */
export function labelTokens(s: string): string {
  return s
    .toLowerCase()
    .split('/')
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .sort()
    .join('|');
}

type ResolvedLine = {
  sku?: string;
  product_id?: string;
  variant_id?: number;
  quantity: number;
};

/**
 * Turn caller-supplied replacement lines into Printify-native line items.
 *
 * The reliable identifier is the variant LABEL ("Blue Jean / L") that Printify
 * generates for both its own variant and the linked Shopify variant. We match
 * that label against the products already on the original order to recover
 * Printify's product_id + variant_id, instead of trusting a Shopify SKU that
 * may not equal Printify's. Falls back to whatever ids/sku the caller gave.
 */
async function resolvePrintifyLineItems(
  client: PrintifyClient,
  original: PrintifyOrder,
  desired: NonNullable<RecreateInput['lineItems']>
): Promise<ResolvedLine[]> {
  const productCache = new Map<string, PrintifyProduct | null>();
  const getProd = async (id: string): Promise<PrintifyProduct | null> => {
    if (!productCache.has(id)) {
      try {
        productCache.set(id, await client.getProduct(id));
      } catch {
        productCache.set(id, null);
      }
    }
    return productCache.get(id) ?? null;
  };

  const productIds = [...new Set(original.line_items.map((li) => li.product_id))];
  // Product affinity: which original product a desired line belongs to, by
  // fuzzy title match against the original line items' metadata titles.
  const wordsOf = (s: string) =>
    s.toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const titleMatchesPid = (title: string, pid: string) =>
    original.line_items.some((li) => {
      if (li.product_id !== pid) return false;
      const liTitle = li.metadata?.title || '';
      const tw = wordsOf(liTitle);
      const hits = wordsOf(title).filter((h) =>
        tw.some((t) => t === h || t.startsWith(h.slice(0, 4)) || h.startsWith(t.slice(0, 4)))
      ).length;
      return hits >= Math.min(2, wordsOf(title).length);
    });

  const out: ResolvedLine[] = [];
  for (const line of desired) {
    let resolved: ResolvedLine | null = null;

    if (line.variantLabel) {
      const target = labelTokens(line.variantLabel);
      // Try title-matching products FIRST so the label lands on the right
      // design; every product still gets tried as a fallback.
      const ordered = line.itemTitle
        ? [
            ...productIds.filter((pid) => titleMatchesPid(line.itemTitle as string, pid)),
            ...productIds.filter((pid) => !titleMatchesPid(line.itemTitle as string, pid)),
          ]
        : productIds;
      for (const pid of ordered) {
        const product = await getProd(pid);
        if (!product) continue;
        const match =
          product.variants.find(
            (v) => v.is_enabled && labelTokens(v.title) === target
          ) || product.variants.find((v) => labelTokens(v.title) === target);
        if (match) {
          resolved = { product_id: pid, variant_id: match.id, quantity: line.quantity };
          break;
        }
      }
    }

    if (!resolved) {
      // Fall back to explicit ids, then SKU.
      resolved =
        line.product_id && line.variant_id
          ? {
              product_id: line.product_id,
              variant_id: line.variant_id,
              quantity: line.quantity,
            }
          : { sku: line.sku, quantity: line.quantity };
    }

    out.push(resolved);
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

  // Refuse to recreate FROM a cancelled order. Two near-simultaneous changes
  // (e.g. an address fix racing an item swap, or the payment watcher racing a
  // customer action) can both resolve the same original; the loser must abort
  // here, not spawn a duplicate replacement of an order that was already
  // replaced. (canCancelOrder alone lets cancelled orders through - their
  // status is neither in-production nor sent_to_production.)
  if (/^cancell?ed$/i.test(original.status || '')) {
    return {
      success: false,
      error:
        'Printify order is already cancelled (another change may have just replaced it) - nothing was created. Re-check the order and retry against its live copy.',
    };
  }

  if (!PrintifyClient.canCancelOrder(original)) {
    return {
      success: false,
      inProduction: true,
      error: 'Printify order is already in production and cannot be cancelled',
    };
  }

  // Use the caller's replacement items (item change) when given; otherwise
  // copy the original order's items (address-only change). Item-change lines
  // resolve to Printify's own product_id + variant_id by variant label.
  const lineItems: ResolvedLine[] = input.lineItems
    ? await resolvePrintifyLineItems(printifyClient, original, input.lineItems)
    : original.line_items.map((li) => {
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

  // Every line must resolve to either a SKU or a product+variant pair, or
  // Printify rejects the whole order (often with an opaque 500). Catch it here
  // with a clear message - before touching the original order.
  const unresolved = (lineItems as {
    sku?: string;
    product_id?: string;
    variant_id?: number;
  }[]).filter((li) => !li.sku && !(li.product_id && li.variant_id));
  if (unresolved.length > 0) {
    return {
      success: false,
      error:
        'Could not identify the replacement item on Printify (missing SKU and product/variant id). ' +
        'Nothing was cancelled - use "Edit details" to pick the item, or change it in Printify.',
    };
  }

  // external_id must be unique across the shop - suffix with a timestamp
  const baseExternalId =
    original.external_id || input.shopifyOrderName?.replace('#', '') || input.printifyOrderId;
  const externalId = `${baseExternalId}-R${Date.now()}`;

  // Create the NEW order FIRST. If this fails (bad SKU, Printify 500, etc.) we
  // abort with the ORIGINAL order still live - the customer is never left with
  // a cancelled order and no replacement, which is the one truly bad outcome.
  let newOrder: PrintifyOrder;
  try {
    const mergedAddress = compactAddress({
      ...original.address_to,
      ...(input.newAddress || {}),
    });
    // Normalize the country to an ISO code - Printify's read returns the full
    // name but create requires the code, else it 500s.
    mergedAddress.country = toCountryCode(mergedAddress.country);
    newOrder = await printifyClient.createOrder({
      external_id: externalId,
      label: input.shopifyOrderName || original.label || undefined,
      // shipping_method is required on create; carry over the original order's
      // (default to 1 = standard).
      shipping_method: original.shipping_method || 1,
      address_to: mergedAddress,
      line_items: lineItems,
      // The original Shopify order keeps notifying the customer; the
      // recreated Printify order must stay silent.
      send_shipping_notification: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    // Log the exact payload we sent (the client already retried 5xx/429 a few
    // times, so reaching here means Printify kept failing). This makes a
    // recurring failure diagnosable - share the resolved variants + Printify's
    // request_id with their support, or spot a bad variant/SKU.
    console.error('[recreatePrintifyOrder] createOrder failed', {
      externalId,
      lineItems,
      message,
    });
    return {
      success: false,
      error:
        `Could not create the new Printify order: ${message}. ` +
        'Your original order was left untouched - nothing was cancelled. Try again in a minute (this is usually a temporary Printify error); if it keeps failing, the Printify request_id in this message can be sent to Printify support.',
    };
  }

  // The new order is live. Now cancel the ORIGINAL. If that fails, roll back by
  // cancelling the order we just created, so the customer is never double-made.
  const cancelResult = await printifyClient.cancelOrder(input.printifyOrderId);
  if (!cancelResult.success) {
    const rollback = await printifyClient.cancelOrder(newOrder.id);
    return {
      success: false,
      error: rollback.success
        ? `Could not cancel the original Printify order (${cancelResult.error || 'unknown error'}). Rolled back the new order - your original order is unchanged.`
        : `Could not cancel the original Printify order, and rolling back the new order (${newOrder.id}) also failed. BOTH orders may now exist - cancel one in Printify to avoid a duplicate.`,
    };
  }

  // If the cancelled order was itself a tracked recreate, close out its
  // relink row - it will never ship
  await prisma.orderRelink
    .updateMany({
      where: {
        printifyOrderId: input.printifyOrderId,
        status: { in: ['PENDING', 'IN_PRODUCTION'] },
      },
      data: { status: 'CANCELLED' },
    })
    .catch(() => undefined);

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

  const createRes = await shopifyClient.createFulfillment(relink.shopifyOrderId, {
    trackingNumber: shipment.number,
    carrier: shipment.carrier,
    trackingUrl: shipment.url,
    notifyCustomer: true,
  });

  // Already-shipped order (a lost order being reshipped): the original
  // fulfillment already exists with the old, lost tracking, so createFulfillment
  // no-ops. Replace the tracking on that live fulfillment with the reship's and
  // re-notify the customer. Only ever touches THIS order's own fulfillment.
  let pushResult: { success: boolean; error?: string };
  if (createRes.success && createRes.alreadyFulfilled) {
    const upd = await shopifyClient.updateFulfillmentTracking(
      relink.shopifyOrderId,
      {
        trackingNumber: shipment.number,
        carrier: shipment.carrier,
        trackingUrl: shipment.url,
        notifyCustomer: true,
      }
    );
    pushResult = { success: upd.success, error: upd.errors?.join('; ') };
  } else {
    pushResult = { success: createRes.success, error: createRes.errors?.join('; ') };
  }

  if (!pushResult.success) {
    const error = pushResult.error || 'Fulfillment push failed';
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
  // Printify's order LIST endpoint returns API-created orders with empty
  // top-level external_id/label - our external_id shows up as
  // metadata.shop_order_id and the label as metadata.shop_order_label.
  const candidates = await prisma.printifyOrderCache.findMany({
    where: {
      OR: [
        { externalId: { contains: '-R' } },
        { metadataShopOrderId: { contains: '-R' } },
      ],
    },
    select: {
      id: true,
      externalId: true,
      metadataShopOrderId: true,
      label: true,
      metadataShopOrderLabel: true,
      status: true,
    },
    take: 200,
  });

  let healed = 0;
  for (const c of candidates) {
    const ext = c.externalId || c.metadataShopOrderId;
    if (!ext || !/-R\d+$/.test(ext)) continue;
    // A cancelled recreate was itself replaced - nothing to push for it
    if (c.status === 'cancelled' || c.status === 'canceled') continue;

    const existing = await prisma.orderRelink.findUnique({
      where: { printifyOrderId: c.id },
      select: { id: true },
    });
    if (existing) continue;

    // Resolve the original Shopify order: prefer the label ("#18100"),
    // fall back to the external-id base with all -R suffixes stripped
    let base = ext.replace(/(-R\d+)+$/, '');
    const lbl = c.label || c.metadataShopOrderLabel;
    if (lbl?.startsWith('#')) base = lbl.slice(1);
    try {
      const shopify = await createShopifyClient();
      if (!shopify) return healed;
      const order = await shopify.getOrderByNumber(base);
      if (!order) {
        console.warn(
          `[Relink] Orphaned recreate ${c.id} (${ext}): no Shopify order "${base}" found`
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
        `[Relink] Healed orphaned recreate ${c.id} -> ${order.name} (${ext})`
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
 * Ensure Printify webhooks are registered for every event the desk consumes -
 * relink shipment push-back plus the order-cache refresh topics - pointing at
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
  const topics = [
    ...new Set([...RELINK_WEBHOOK_TOPICS, ...ORDER_CACHE_WEBHOOK_TOPICS]),
  ];

  try {
    const existing = await printifyClient.listWebhooks();
    for (const topic of topics) {
      const match = existing.find((w) => w.topic === topic && w.url === url);
      if (match) continue;
      // Per-topic isolation: one rejected topic (e.g. a name Printify stops
      // supporting) must not block registering the rest.
      try {
        await printifyClient.createWebhook({ topic, url, secret });
        console.log(`[Relink] Registered Printify webhook ${topic} -> ${url}`);
      } catch (err) {
        console.error(
          `[Relink] Failed to register webhook ${topic} (poll fallback still active):`,
          err instanceof Error ? err.message : err
        );
      }
    }
  } catch (err) {
    console.error(
      '[Relink] Webhook registration failed (poll fallback still active):',
      err instanceof Error ? err.message : err
    );
  }
}
