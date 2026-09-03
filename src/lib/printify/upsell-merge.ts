/**
 * Post-purchase upsell merge.
 *
 * A post-purchase upsell app (Kaching) adds the upsold tee to the SAME Shopify
 * order after payment. Printify snapshots an order at payment and ignores every
 * later edit, so its auto-created order is missing the upsold item and the
 * customer would receive a short shipment.
 *
 * This module reconciles that the same way the address/item-change flows do:
 * cancel the stale Printify copy and recreate ONE order carrying every current
 * line, through `recreatePrintifyOrder`. That buys three things for free -
 * the OrderRelink row (so tracking still lands on the ORIGINAL Shopify order),
 * the cache write, and the concurrency guard against a customer editing the
 * same order at the same moment.
 *
 * DELIBERATELY NOT sent to production. Verified 2026-09-03 against live orders:
 * every API-created order on this shop (`#37158-combined`, `37166-R`, ...) sits
 * on-hold and Printify's own nightly sweep submits it (~07:07 UTC). Sending it
 * ourselves would only destroy the window the self-service portal depends on -
 * the portal fails closed on anything already in production, so an early send
 * would take cancel, address change and size swap away from exactly the
 * customers who just spent more.
 *
 * Safety, in order of how much each one saves you:
 *  1. TAG GATE - only orders the upsell app tagged are ever touched. SKU-based
 *     detection is what cost another store ~$3,000 in duplicate production.
 *  2. FEATURE FLAG - off unless UPSELL_MERGE_ENABLED=true, and it refuses to
 *     run at all without an explicit UPSELL_ORDER_TAG (no guessed default).
 *  3. CIRCUIT BREAKER - more tagged orders in one sweep than UPSELL_MAX_TOUCH
 *     means the tag logic broke; halt the whole sweep and alert, write nothing.
 *  4. NEVER auto-creates a second order. An order already in production is
 *     reported to a human instead - a missing item we shout about beats a
 *     duplicate box we created quietly.
 */

import prisma from '@/lib/db';
import { createPrintifyClient, PrintifyClient } from '@/lib/printify';
import { recreatePrintifyOrder } from '@/lib/printify/relink';
import type { PrintifyOrder } from '@/lib/printify/types';
import { createShopifyClient } from '@/lib/shopify';
import type { ShopifyOrder } from '@/lib/shopify/types';
import { resolvePrintifyOrders } from '@/lib/self-service/orders';
import { notifySelfServiceFailure } from '@/lib/self-service/alerts';
import { selfServiceMonitor } from '@/lib/self-service/monitor';

/** The tag the upsell app puts on every order it edits. No default on purpose:
 *  a guessed tag either matches nothing (silent no-op) or matches too much. */
export function upsellTag(): string {
  return (process.env.UPSELL_ORDER_TAG || '').trim();
}

export function upsellMergeEnabled(): boolean {
  return process.env.UPSELL_MERGE_ENABLED === 'true' && upsellTag().length > 0;
}

/** More tagged orders than this in one sweep = something is wrong, not a good day. */
function maxTouch(): number {
  const n = parseInt(process.env.UPSELL_MAX_TOUCH || '8', 10);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

/** How far back a sweep looks. Printify's nightly sweep prints the same night,
 *  so anything older than this is past saving by merge anyway. */
const LOOKBACK_DAYS = 2;

export function isUpsellTagged(tags: string[], tag = upsellTag()): boolean {
  if (!tag) return false;
  const needle = tag.toLowerCase();
  return tags.some((t) => t.trim().toLowerCase().includes(needle));
}

/**
 * What SHOULD ship, per SKU. `quantity` is Shopify's currentQuantity, so it is
 * already net of order edits AND refunded units - a customer who refunds the
 * upsell before the merge runs simply stops it being added.
 */
export function desiredSkuQuantities(order: ShopifyOrder): Record<string, number> {
  const out: Record<string, number> = {};
  for (const li of order.lineItems) {
    if (!li.sku || li.quantity <= 0) continue;
    out[li.sku] = (out[li.sku] || 0) + li.quantity;
  }
  return out;
}

/** What Printify currently holds, per SKU. */
export function printifySkuQuantities(po: PrintifyOrder): Record<string, number> {
  const out: Record<string, number> = {};
  for (const li of po.line_items) {
    const sku = li.metadata?.sku;
    if (!sku) continue;
    out[sku] = (out[sku] || 0) + li.quantity;
  }
  return out;
}

export interface SkuDiff {
  /** On Shopify, missing (or short) on Printify - the upsell. */
  missing: Record<string, number>;
  /** On Printify but no longer wanted - a refunded/removed line. */
  extra: Record<string, number>;
  /** Every Printify line carries a SKU, so the diff can be trusted. */
  skusKnown: boolean;
}

/**
 * Per-SKU QUANTITY diff, not a line count. A count compare misses an upsell
 * that just bumps the quantity of a SKU already on the order.
 */
export function diffSkus(order: ShopifyOrder, po: PrintifyOrder): SkuDiff {
  const want = desiredSkuQuantities(order);
  const have = printifySkuQuantities(po);
  const skusKnown = po.line_items.every((li) => Boolean(li.metadata?.sku));

  const missing: Record<string, number> = {};
  const extra: Record<string, number> = {};
  for (const [sku, qty] of Object.entries(want)) {
    const diff = qty - (have[sku] || 0);
    if (diff > 0) missing[sku] = diff;
  }
  for (const [sku, qty] of Object.entries(have)) {
    const diff = qty - (want[sku] || 0);
    if (diff > 0) extra[sku] = diff;
  }
  return { missing, extra, skusKnown };
}

export interface MergedLine {
  sku?: string;
  product_id?: string;
  variant_id?: number;
  quantity: number;
}

/**
 * Build the line set for the merged order.
 *
 * Lines Printify ALREADY holds are copied verbatim by product_id + variant_id -
 * never re-resolved, so a rebuild can't silently land on a different design
 * (the #27253 class of bug). Only the added upsell line goes in by SKU, which
 * is safe here: verified 2026-09-03 that Shopify and Printify carry identical
 * SKUs on this store (the products are published FROM Printify). Note the
 * variant LABELS differ in order ("Moss / M" vs "M / Moss"), so labels must
 * never be used as the key.
 *
 * Quantities are clamped down to what is still wanted, so a partial refund
 * that lands before the merge doesn't get reprinted.
 */
export function buildMergedLines(po: PrintifyOrder, diff: SkuDiff): MergedLine[] {
  const remainingExtra = { ...diff.extra };
  const lines: MergedLine[] = [];

  for (const li of po.line_items) {
    let qty = li.quantity;
    const sku = li.metadata?.sku;
    if (sku && remainingExtra[sku] > 0) {
      const drop = Math.min(qty, remainingExtra[sku]);
      qty -= drop;
      remainingExtra[sku] -= drop;
    }
    if (qty > 0) {
      lines.push({ product_id: li.product_id, variant_id: li.variant_id, quantity: qty });
    }
  }

  for (const [sku, qty] of Object.entries(diff.missing)) {
    if (qty > 0) lines.push({ sku, quantity: qty });
  }
  return lines;
}

export type MergeOutcome =
  | 'merged'
  | 'already-matches'
  | 'already-merged'
  | 'waiting-for-printify'
  | 'skipped-cancelled'
  | 'in-production'
  | 'ambiguous-copies'
  | 'unknown-skus'
  | 'failed';

export interface MergeResult {
  orderName: string;
  outcome: MergeOutcome;
  newPrintifyOrderId?: string;
  added?: Record<string, number>;
  error?: string;
}

/**
 * Reconcile ONE upsold Shopify order. Idempotent: safe to call every sweep.
 */
export async function mergeUpsoldOrder(order: ShopifyOrder): Promise<MergeResult> {
  const name = order.name;

  if (order.cancelledAt) return { orderName: name, outcome: 'skipped-cancelled' };

  // Already merged once - the relink row is the durable marker, so a restart or
  // a re-run can never build a second order.
  const prior = await prisma.orderRelink.findFirst({
    where: { shopifyOrderId: order.id, reason: 'UPSELL' },
  });
  if (prior) return { orderName: name, outcome: 'already-merged' };

  const { live } = await resolvePrintifyOrders(order, { source: 'live' });
  if (live.length === 0) {
    // Printify has not imported it yet. Creating anything now would collide
    // with that import and leave two orders.
    return { orderName: name, outcome: 'waiting-for-printify' };
  }
  if (live.length > 1) {
    return { orderName: name, outcome: 'ambiguous-copies' };
  }

  const copy = live[0];
  if (!copy.order) return { orderName: name, outcome: 'ambiguous-copies' };

  const diff = diffSkus(order, copy.order);
  if (!diff.skusKnown) return { orderName: name, outcome: 'unknown-skus' };
  if (Object.keys(diff.missing).length === 0) {
    // Nothing to add. A refund-only difference is the refund flow's business,
    // not ours - we never cancel a Printify order just to remove a line.
    return { orderName: name, outcome: 'already-matches' };
  }

  if (!PrintifyClient.canCancelOrder(copy.order)) {
    return { orderName: name, outcome: 'in-production' };
  }

  const lines = buildMergedLines(copy.order, diff);
  if (lines.length === 0) return { orderName: name, outcome: 'already-matches' };

  const result = await recreatePrintifyOrder({
    printifyOrderId: copy.id,
    shopifyOrderId: order.id,
    shopifyOrderName: order.name,
    reason: 'UPSELL',
    lineItems: lines,
  });

  if (!result.success || !result.newPrintifyOrderId) {
    return {
      orderName: name,
      outcome: result.inProduction ? 'in-production' : 'failed',
      error: result.error,
    };
  }

  return {
    orderName: name,
    outcome: 'merged',
    newPrintifyOrderId: result.newPrintifyOrderId,
    added: diff.missing,
  };
}

export interface SweepSummary {
  scanned: number;
  merged: number;
  skipped: number;
  failed: number;
  breakerTripped: boolean;
}

/**
 * One pass: find upsold orders, merge the ones that need it, tell Slack.
 */
export async function runUpsellMergeSweep(): Promise<SweepSummary> {
  const empty: SweepSummary = {
    scanned: 0,
    merged: 0,
    skipped: 0,
    failed: 0,
    breakerTripped: false,
  };
  if (!upsellMergeEnabled()) return empty;

  const shopify = await createShopifyClient();
  if (!shopify) return empty;
  // Fail fast rather than half-work: every merge needs Printify.
  if (!(await createPrintifyClient())) return empty;

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const tag = upsellTag().replace(/'/g, '');
  const orders = await shopify.getOrdersByQuery(
    `tag:'${tag}' AND created_at:>=${since}`,
    50
  );

  // Belt and braces: the Shopify tag search is fuzzy, so re-check each order's
  // own tags before it can reach anything that writes.
  const tagged = orders.filter((o) => isUpsellTagged(o.tags));
  if (tagged.length === 0) return { ...empty, scanned: orders.length };

  if (tagged.length > maxTouch()) {
    await notifySelfServiceFailure({
      flow: 'upsell-merge',
      orderName: `${tagged.length} orders`,
      step: 'circuit breaker',
      error: `${tagged.length} orders carry the upsell tag in one sweep (max ${maxTouch()})`,
      humanAction:
        'Nothing was changed. Check the upsell app is not mass-tagging, then ' +
        'raise UPSELL_MAX_TOUCH or fix the tag.',
      detail: { orders: tagged.map((o) => o.name).join(', ') },
    });
    return { ...empty, scanned: orders.length, breakerTripped: true };
  }

  const summary: SweepSummary = {
    scanned: orders.length,
    merged: 0,
    skipped: 0,
    failed: 0,
    breakerTripped: false,
  };

  for (const order of tagged) {
    let res: MergeResult;
    try {
      res = await mergeUpsoldOrder(order);
    } catch (err) {
      res = {
        orderName: order.name,
        outcome: 'failed',
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }

    switch (res.outcome) {
      case 'merged': {
        summary.merged++;
        const added = Object.entries(res.added || {})
          .map(([sku, qty]) => `${qty}x ${sku}`)
          .join(', ');
        await selfServiceMonitor({
          text:
            `:package: Upsell merged - ${res.orderName} now prints as ONE order ` +
            `(added ${added}). Left on hold for tonight's Printify sweep, so the ` +
            `customer can still cancel or change it.`,
          shopifyOrderId: order.id,
          printifyOrderId: res.newPrintifyOrderId,
        });
        break;
      }
      case 'in-production':
        summary.failed++;
        await notifySelfServiceFailure({
          flow: 'upsell-merge',
          orderName: res.orderName,
          step: 'merge upsold item into the Printify order',
          error:
            res.error ||
            'The Printify order is already in production, so it cannot be rebuilt.',
          humanAction:
            'The upsold item will NOT ship. Place the missing item as a separate ' +
            'Printify order by hand, or refund it.',
          customerEmail: order.customerEmail,
          detail: { shopifyOrderId: order.id, added: res.added },
        });
        break;
      case 'ambiguous-copies':
        summary.skipped++;
        await notifySelfServiceFailure({
          flow: 'upsell-merge',
          orderName: res.orderName,
          step: 'find the Printify order to merge into',
          error: 'More than one live Printify order (or an unreadable one) for this order.',
          humanAction:
            'Check Printify by hand: the upsold item may be missing. Nothing was changed.',
          customerEmail: order.customerEmail,
          detail: { shopifyOrderId: order.id },
        });
        break;
      case 'unknown-skus':
      case 'failed':
        summary.failed++;
        await notifySelfServiceFailure({
          flow: 'upsell-merge',
          orderName: res.orderName,
          step: 'rebuild the Printify order with the upsold item',
          error: res.error || 'A Printify line item has no SKU, so the diff is not safe.',
          humanAction:
            'Check the Printify order still exists and holds every item. If it was ' +
            'cancelled and not replaced, recreate it by hand TODAY - nothing will print.',
          customerEmail: order.customerEmail,
          detail: { shopifyOrderId: order.id },
        });
        break;
      default:
        summary.skipped++;
    }
  }

  return summary;
}
