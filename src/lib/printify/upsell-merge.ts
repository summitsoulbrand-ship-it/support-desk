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

/**
 * Log-only mode. Everything runs - the tag gate, the Printify lookup, the diff,
 * the plan - and stops before the first write. The guide's advice, and the
 * cheapest way to prove the tag is right against REAL orders before the bot is
 * allowed to touch one.
 */
export function upsellDryRun(): boolean {
  return process.env.UPSELL_MERGE_DRY_RUN === 'true';
}

/**
 * More orders NEEDING A MERGE in one sweep than this = something is wrong.
 *
 * This counts orders that still need work, NOT every tagged order in the
 * window. That distinction is the whole point: at ~230 orders every two days
 * and the guide's 3-5% take rate, 7-11 orders carry the tag at any moment, so a
 * threshold against tagged orders would trip on every single sweep and merge
 * nothing. Orders already merged are filtered out first, which in steady state
 * leaves 0-1 per two-minute sweep.
 */
function maxTouch(): number {
  const n = parseInt(process.env.UPSELL_MAX_TOUCH || '8', 10);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

/**
 * The kill switch. The guide's version watched for duplicate orders; this one
 * caps how many merges can happen in a day at all. Upsells run 3-5% of orders,
 * so a day that wants more merges than this is a bug, not a good day.
 */
function maxDaily(): number {
  const n = parseInt(process.env.UPSELL_MAX_DAILY || '30', 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/**
 * How far back a sweep looks. Deliberately shorter than a day: Printify's
 * nightly sweep sends everything to production around 07:07 UTC, so an order
 * older than that has already printed and cannot be merged - reaching further
 * back only produces alerts about orders nothing can save.
 */
function lookbackHours(): number {
  const n = parseInt(process.env.UPSELL_LOOKBACK_HOURS || '24', 10);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

/**
 * A tripped breaker must not shout every two minutes. Alert once, then stay
 * quiet for an hour - Slack noise gets muted, and a muted alarm is no alarm.
 */
let lastBreakerAlert = 0;
const BREAKER_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * HALTED state. A tripped breaker or kill switch means orders STOP being
 * merged, so it is not enough to alert once and move on - the channel has to
 * keep saying so, or a Slack message scrolled past on a Friday becomes a week
 * of upsells shipping short. Cleared the moment a sweep runs normally again.
 */
let haltedSince: number | null = null;
const HALT_REMINDER_MS = 6 * 60 * 60 * 1000;
let lastHaltReminder = 0;

/** Is the merge currently stopped? Exposed so the daily heartbeat can say so. */
export function upsellHaltedSince(): Date | null {
  return haltedSince === null ? null : new Date(haltedSince);
}

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

/** What a SET of Printify copies holds between them, per SKU. */
export function combinedSkuQuantities(copies: PrintifyOrder[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const po of copies) {
    for (const [sku, qty] of Object.entries(printifySkuQuantities(po))) {
      out[sku] = (out[sku] || 0) + qty;
    }
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
 *
 * Takes ALL the Printify copies together, because the upsold item may have
 * arrived as its own second Printify order rather than being ignored - in
 * which case the two copies between them already hold everything, and the job
 * is to fold them into one box rather than to add anything.
 */
export function diffSkus(order: ShopifyOrder, copies: PrintifyOrder[]): SkuDiff {
  const want = desiredSkuQuantities(order);
  const have = combinedSkuQuantities(copies);
  const skusKnown = copies.every((po) =>
    po.line_items.every((li) => Boolean(li.metadata?.sku))
  );

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
 * Build the line set for the merged order - ONE order carrying every line from
 * every copy.
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
export function buildMergedLines(copies: PrintifyOrder[], diff: SkuDiff): MergedLine[] {
  const remainingExtra = { ...diff.extra };
  const lines: MergedLine[] = [];

  for (const po of copies) {
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
  }

  for (const [sku, qty] of Object.entries(diff.missing)) {
    if (qty > 0) lines.push({ sku, quantity: qty });
  }
  return lines;
}

export type MergeOutcome =
  | 'merged'
  | 'would-merge'
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
  /** How many Printify orders were folded into the one that will print. */
  mergedCopies?: number;
  /** Orders left live that should have been cancelled - a human must act. */
  uncancelled?: string[];
  /** Dry run only: how many lines the merged order would have carried. */
  plannedLines?: number;
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
  // A copy we could not read live is a copy we cannot prove is safe to cancel.
  if (live.some((c) => !c.order)) {
    return { orderName: name, outcome: 'ambiguous-copies' };
  }
  const copies = live.map((c) => c.order as PrintifyOrder);

  // Several Printify copies can be innocent (a replacement for a damaged
  // shirt) or the upsell arriving as its own second order. Folding a genuine
  // REPLACEMENT into the merge would cancel a shirt someone is owed, so any
  // copy we already track for another reason stops the merge dead.
  if (live.length > 1) {
    const tracked = await prisma.orderRelink.findMany({
      where: {
        printifyOrderId: { in: live.map((c) => c.id) },
        reason: { in: ['REPLACEMENT', 'REROUTE'] },
      },
      select: { printifyOrderId: true },
    });
    if (tracked.length > 0) return { orderName: name, outcome: 'ambiguous-copies' };
  }

  const diff = diffSkus(order, copies);
  if (!diff.skusKnown) return { orderName: name, outcome: 'unknown-skus' };

  // Several copies holding something Shopify no longer wants is not a plain
  // upsell - it is a replacement, a manual order, or a mess. Rebuilding would
  // throw that item away, so hand it to a human instead.
  if (live.length > 1 && Object.keys(diff.extra).length > 0) {
    return { orderName: name, outcome: 'ambiguous-copies' };
  }

  const needsMerge = Object.keys(diff.missing).length > 0;
  // Two copies that BETWEEN them already hold everything still need merging:
  // nothing is missing, but the customer would get two boxes and two tracking
  // numbers for one order.
  const splitAcrossOrders = live.length > 1;
  if (!needsMerge && !splitAcrossOrders) {
    // Nothing to add. A refund-only difference is the refund flow's business,
    // not ours - we never cancel a Printify order just to remove a line.
    return { orderName: name, outcome: 'already-matches' };
  }

  // EVERY copy has to be cancelable, checked before anything is created.
  if (!copies.every((po) => PrintifyClient.canCancelOrder(po))) {
    return { orderName: name, outcome: 'in-production' };
  }

  const lines = buildMergedLines(copies, diff);
  if (lines.length === 0) return { orderName: name, outcome: 'already-matches' };

  // Log-only mode stops HERE - after everything has been worked out, before the
  // first write. Nothing is created, nothing is cancelled.
  if (upsellDryRun()) {
    return {
      orderName: name,
      outcome: 'would-merge',
      mergedCopies: copies.length,
      added: diff.missing,
      plannedLines: lines.length,
    };
  }

  // The oldest copy is the primary (resolvePrintifyOrders returns them oldest
  // first); the rest are folded in and cancelled with it.
  const result = await recreatePrintifyOrder({
    printifyOrderId: live[0].id,
    alsoCancelPrintifyOrderIds: live.slice(1).map((c) => c.id),
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
    mergedCopies: copies.length,
    uncancelled: result.uncancelledPrintifyOrderIds,
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

  const since = new Date(Date.now() - lookbackHours() * 60 * 60 * 1000).toISOString();
  const tag = upsellTag().replace(/'/g, '');
  const orders = await shopify.getOrdersByQuery(
    `tag:'${tag}' AND created_at:>=${since}`,
    50
  );

  // Belt and braces: the Shopify tag search is fuzzy, so re-check each order's
  // own tags before it can reach anything that writes.
  const tagged = orders.filter((o) => isUpsellTagged(o.tags));
  if (tagged.length === 0) return { ...empty, scanned: orders.length };

  // Drop the ones already merged, in ONE query, BEFORE the breaker. At this
  // store's volume most tagged orders in the window are already done, and
  // counting them would trip the breaker on every sweep.
  const done = await prisma.orderRelink.findMany({
    where: { shopifyOrderId: { in: tagged.map((o) => o.id) }, reason: 'UPSELL' },
    select: { shopifyOrderId: true },
  });
  const doneIds = new Set(done.map((d) => d.shopifyOrderId));
  const candidates = tagged.filter((o) => !doneIds.has(o.id));
  if (candidates.length === 0) return { ...empty, scanned: orders.length };

  const breakerAlert = async (step: string, error: string, humanAction: string) => {
    const now = Date.now();
    if (haltedSince === null) haltedSince = now;
    // First trip alerts immediately. After that it repeats every 6 hours for as
    // long as merging is stopped, because the danger is forgetting, not missing
    // the first message.
    const firstTrip = now - lastBreakerAlert >= BREAKER_ALERT_COOLDOWN_MS;
    const reminderDue = now - lastHaltReminder >= HALT_REMINDER_MS;
    if (!firstTrip && !reminderDue) return;
    lastBreakerAlert = now;
    lastHaltReminder = now;
    const stoppedFor = Math.round((now - haltedSince) / 60000);
    await notifySelfServiceFailure({
      flow: 'upsell-merge',
      orderName: `${candidates.length} orders`,
      step,
      error:
        `${error}. UPSELL MERGING IS STOPPED` +
        (stoppedFor > 0 ? ` - has been for ${stoppedFor} min.` : '.') +
        ' Upsold items will ship short until this is cleared.',
      humanAction,
      detail: { orders: candidates.map((o) => o.name).join(', ') },
    });
  };

  if (candidates.length > maxTouch()) {
    await breakerAlert(
      'circuit breaker',
      `${candidates.length} orders still need merging in one sweep (max ${maxTouch()})`,
      'Nothing was changed. Check the upsell app is not mass-tagging, then ' +
        'raise UPSELL_MAX_TOUCH or fix the tag.'
    );
    return { ...empty, scanned: orders.length, breakerTripped: true };
  }

  // Kill switch: cap merges per day outright. Upsells are 3-5% of orders, so a
  // day wanting more than this is a bug however innocent each merge looks.
  const mergedToday = await prisma.orderRelink.count({
    where: {
      reason: 'UPSELL',
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });
  if (mergedToday >= maxDaily()) {
    await breakerAlert(
      'daily kill switch',
      `${mergedToday} upsell merges in the last 24h (max ${maxDaily()})`,
      'The bot has STOPPED merging. Check Printify for duplicate orders, then ' +
        'raise UPSELL_MAX_DAILY if the volume is genuinely real.'
    );
    return { ...empty, scanned: orders.length, breakerTripped: true };
  }

  // Past both gates: merging is working again. Say so once, so a "STOPPED"
  // message is never the last word anyone saw.
  if (haltedSince !== null) {
    const stoppedFor = Math.round((Date.now() - haltedSince) / 60000);
    haltedSince = null;
    lastBreakerAlert = 0;
    lastHaltReminder = 0;
    await selfServiceMonitor({
      text:
        `:white_check_mark: Upsell merging is running again after ${stoppedFor} min stopped.`,
      channel: 'upsell',
    });
  }

  const summary: SweepSummary = {
    scanned: orders.length,
    merged: 0,
    skipped: 0,
    failed: 0,
    breakerTripped: false,
  };

  for (const order of candidates) {
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
        const what = added
          ? `added ${added}`
          : `folded ${res.mergedCopies} Printify orders into one`;
        await selfServiceMonitor({
          text:
            `:package: Upsell merged - ${res.orderName} now prints as ONE order ` +
            `(${what}). Left on hold for tonight's Printify sweep, so the ` +
            `customer can still cancel or change it.`,
          shopifyOrderId: order.id,
          printifyOrderId: res.newPrintifyOrderId,
          channel: 'upsell',
        });
        // The merge worked, but an old copy refused to cancel. Cancellation is
        // irreversible so there was no clean rollback - without a human it
        // prints twice tonight.
        if (res.uncancelled && res.uncancelled.length > 0) {
          summary.failed++;
          await notifySelfServiceFailure({
            flow: 'upsell-merge',
            orderName: res.orderName,
            step: 'cancel the old Printify order after merging',
            error: `Could not cancel ${res.uncancelled.join(', ')} - it is still live.`,
            humanAction:
              'CANCEL those Printify orders by hand NOW, before tonight. The merged ' +
              `order ${res.newPrintifyOrderId} already holds everything, so leaving ` +
              'them will print the order twice.',
            customerEmail: order.customerEmail,
            detail: { shopifyOrderId: order.id, newPrintifyOrderId: res.newPrintifyOrderId },
          });
        }
        break;
      }
      case 'would-merge': {
        summary.merged++;
        const added = Object.entries(res.added || {})
          .map(([sku, qty]) => `${qty}x ${sku}`)
          .join(', ');
        await selfServiceMonitor({
          text:
            `:eyes: DRY RUN - would merge ${res.orderName} into ONE order of ` +
            `${res.plannedLines} line(s) from ${res.mergedCopies} Printify order(s)` +
            (added ? `, adding ${added}` : '') +
            `. Nothing was changed.`,
          shopifyOrderId: order.id,
          channel: 'upsell',
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
          error:
            'The Printify copies of this order could not be merged safely - one is ' +
            'unreadable, one is a tracked replacement, or together they hold an item ' +
            'Shopify no longer wants.',
          humanAction:
            'Check Printify by hand: the customer may get two boxes, or be missing the ' +
            'upsold item. Nothing was changed.',
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
        // During a dry run, say something about EVERY tagged order. A trial that
        // only speaks up when it wants to act cannot tell "the tag is right and
        // there was nothing to do" apart from "the tag matched nothing at all",
        // and those need very different fixes.
        if (upsellDryRun()) {
          await selfServiceMonitor({
            text:
              `:eyes: DRY RUN - ${res.orderName} is tagged, nothing to do ` +
              `(${res.outcome}). Nothing was changed.`,
            shopifyOrderId: order.id,
            channel: 'upsell',
          });
        }
    }
  }

  return summary;
}

/**
 * Once-a-day "here is where upsells stand" line in the upsells channel.
 *
 * The breaker and the kill switch shout when THEY stop merging, but they cannot
 * shout if the worker died, the loop was never started, or the flag got turned
 * off - and those failures look exactly like a quiet day. This posts every day
 * whether or not anything happened, so silence in the channel becomes a signal
 * in itself rather than something to interpret.
 */
export async function postUpsellHeartbeat(): Promise<void> {
  if (!upsellMergeEnabled()) return;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const merged = await prisma.orderRelink.count({
    where: { reason: 'UPSELL', createdAt: { gte: since } },
  });

  const halted = upsellHaltedSince();
  if (halted) {
    const mins = Math.round((Date.now() - halted.getTime()) / 60000);
    await selfServiceMonitor({
      text:
        `:octagonal_sign: Upsell merge daily check: STOPPED for ${mins} min. ` +
        `Nothing is being merged, so upsold items are shipping short. ` +
        `${merged} merged in the last 24h before it stopped.`,
      channel: 'upsell',
    });
    return;
  }

  await selfServiceMonitor({
    text:
      `:heartbeat: Upsell merge daily check: running normally. ` +
      `${merged} order(s) merged in the last 24h` +
      (upsellDryRun() ? ' (DRY RUN - nothing is actually being changed).' : '.'),
    channel: 'upsell',
  });
}
