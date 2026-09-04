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
import { createAddOnPrintifyOrder, recreatePrintifyOrder } from '@/lib/printify/relink';
import type { PrintifyOrder } from '@/lib/printify/types';
import { createShopifyClient } from '@/lib/shopify';
import type { ShopifyOrder } from '@/lib/shopify/types';
import { hasActiveReroute, resolvePrintifyOrders } from '@/lib/self-service/orders';
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

/**
 * Per-order alarms already raised, so a stuck order does not shout every two
 * minutes until Slack gets muted. In memory on purpose: a worker restart
 * re-alerting is the right failure direction for something that ships items
 * short.
 */
const orderAlerts = new Map<string, number>();
const ORDER_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function shouldAlertForOrder(orderId: string, kind: string): boolean {
  const key = `${kind}:${orderId}`;
  const last = orderAlerts.get(key) ?? 0;
  if (Date.now() - last < ORDER_ALERT_COOLDOWN_MS) return false;
  orderAlerts.set(key, Date.now());
  return true;
}

/**
 * How many times one order may be merged before that looks like a loop rather
 * than a customer genuinely adding things. Three covers an upsell, a later
 * order edit, and one more, which is already generous.
 */
function maxMergesPerOrder(): number {
  const n = parseInt(process.env.UPSELL_MAX_MERGES_PER_ORDER || '3', 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

/**
 * How long to let an order SETTLE before touching it.
 *
 * Pati 2026-09-04, after watching #37449 come in at 18:49 and get rebuilt at
 * 18:51: the customer may still be on the post-purchase page, and a second
 * offer or a downsell can land minutes after the first. Rebuilding at the
 * two-minute mark means cancelling and recreating the Printify order again for
 * every one of those. The print deadline is hours away, so waiting is free.
 *
 * Measured from the order's LAST change, so each new edit restarts the clock.
 */
function settleMinutes(): number {
  const n = parseInt(process.env.UPSELL_SETTLE_MINUTES || '10', 10);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

/**
 * ...but never wait longer than this from when the order was placed. Other
 * automations on this store write order tags, and a tag write bumps updatedAt -
 * without a ceiling, a chatty neighbour could hold an upsell back until it was
 * too late to merge at all.
 */
function maxSettleMinutes(): number {
  const n = parseInt(process.env.UPSELL_MAX_SETTLE_MINUTES || '60', 10);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/**
 * How long an upsold order may sit with no live Printify order before that
 * counts as a problem rather than Printify still catching up. Printify usually
 * imports within a minute or two.
 */
const STALE_WAIT_MINUTES = 30;

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
  // Each built line remembers which SKU it came from, so a quantity bump can be
  // folded into the line that already carries it.
  const built: { line: MergedLine; sku?: string }[] = [];

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
        built.push({
          line: { product_id: li.product_id, variant_id: li.variant_id, quantity: qty },
          sku,
        });
      }
    }
  }

  for (const [sku, qty] of Object.entries(diff.missing)) {
    if (qty <= 0) continue;
    // An upsell that just bumps the quantity of something already on the order
    // must ADD TO that line, not append a second line for the same variant.
    // Two lines for one variant is a shape Printify is not asked to handle
    // anywhere else on this store, and the existing line already carries the
    // exact product_id + variant_id - which is the safest identifier there is.
    const existing = built.find((b) => b.sku === sku);
    if (existing) existing.line.quantity += qty;
    else built.push({ line: { sku, quantity: qty }, sku });
  }

  return built.map((b) => b.line);
}

export type MergeOutcome =
  | 'merged'
  | 'would-merge'
  | 'merge-loop'
  | 'unpaid'
  | 'added-second-box'
  | 'already-matches'
  | 'waiting-for-printify'
  | 'skipped-cancelled'
  | 'in-production'
  | 'ambiguous-copies'
  | 'rerouted'
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

  // NEVER print something the customer has not paid for. A post-purchase upsell
  // charges the saved card immediately, so a balance still outstanding means
  // the charge did not go through - or the item was added by an order edit that
  // is still awaiting payment. The portal's pricier-swap flow already refuses to
  // touch Printify until the balance clears; this is the same rule.
  // NaN, not '0', deliberately - the same idiom payment-watch.ts uses. Defaulting
  // a MISSING balance to zero reads as "paid" and silently disables this whole
  // check, which is exactly what happened: totalOutstandingSet was not in the
  // query this sweep uses, so the guard never once fired. Absent now means
  // unknown, and unknown means we do not print.
  const outstanding = parseFloat(order.totalOutstanding ?? 'NaN');
  const paid = Number.isFinite(outstanding) && outstanding <= 0.005;
  if (!paid) {
    return { orderName: name, outcome: 'unpaid' };
  }

  // Merging once is NOT the end of the story: a customer can accept the upsell,
  // and then a second offer or a later order edit can add something else. A
  // blanket "already merged, skip forever" meant that second item silently
  // never reached Printify. So the only hard stop is a loop guard - the diff
  // itself is naturally idempotent and does nothing when nothing is missing.
  const priorMerges = await prisma.orderRelink.count({
    where: { shopifyOrderId: order.id, reason: { in: ['UPSELL', 'UPSELL_ADDON'] } },
  });
  if (priorMerges >= maxMergesPerOrder()) {
    return { orderName: name, outcome: 'merge-loop' };
  }

  // An order manually rerouted to a regional print provider must NEVER be
  // rebuilt: a recreate lands back on the DEFAULT provider and silently loses
  // the reroute, which is how an international order ends up printed in the US.
  // The portal has refused these since it launched; this checks the same way,
  // keyed on the Shopify order, so it holds however many Printify copies exist.
  if (await hasActiveReroute(order.id)) {
    return { orderName: name, outcome: 'rerouted' };
  }

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

  // A copy Printify has only just imported sits in 'pending' and REJECTS a
  // cancel with a 400 for a short window (the kit retries this in a loop).
  // canCancelOrder passes it, because pending is not a production status - so
  // without this we would create the merged order, fail to cancel the original,
  // roll the new one back, and do it all again two minutes later until Printify
  // settles. Wait instead; the print deadline is hours away.
  if (copies.some((po) => /^pending$/i.test(po.status || ''))) {
    return { orderName: name, outcome: 'waiting-for-printify' };
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
  const allCancelable = copies.every((po) => PrintifyClient.canCancelOrder(po));

  if (!needsMerge) {
    // Nothing to add. A refund-only difference is the refund flow's business,
    // not ours - we never cancel a Printify order just to remove a line.
    // Tidying several copies into one is worth doing, but ONLY while they can
    // all still be cancelled; once one is printing, two boxes is simply the
    // outcome, and saying "already matches" is what stops this looping forever.
    if (!splitAcrossOrders || !allCancelable) {
      return { orderName: name, outcome: 'already-matches' };
    }
  }

  // Something IS missing and the order is already printing. Pati's call, and the
  // right one: ship the missing items as their own second box rather than
  // quietly never making them. Cancels nothing, so the box already in
  // production is untouched.
  if (needsMerge && !allCancelable) {
    const addOnLines = Object.entries(diff.missing)
      .filter(([, qty]) => qty > 0)
      .map(([sku, quantity]) => ({ sku, quantity }));
    // This path returns before the dry-run stop further down, so it needs its
    // own. A log-only run that quietly created a real second Printify order
    // would be the worst possible thing for a mode whose whole promise is that
    // it writes nothing.
    if (upsellDryRun()) {
      return {
        orderName: name,
        outcome: 'would-merge',
        mergedCopies: copies.length,
        added: diff.missing,
        plannedLines: addOnLines.length,
      };
    }
    const addOn = await createAddOnPrintifyOrder({
      basedOn: copies[0],
      shopifyOrderId: order.id,
      shopifyOrderName: order.name,
      lineItems: addOnLines,
    });
    if (!addOn.success || !addOn.newPrintifyOrderId) {
      return { orderName: name, outcome: 'failed', error: addOn.error };
    }
    return {
      orderName: name,
      outcome: 'added-second-box',
      newPrintifyOrderId: addOn.newPrintifyOrderId,
      added: diff.missing,
    };
  }

  const lines = buildMergedLines(copies, diff);
  if (lines.length === 0) return { orderName: name, outcome: 'already-matches' };

  // Log-only mode stops HERE - after everything has been worked out, before the
  // first write. Nothing is created, nothing is cancelled. (The second-box path
  // above is guarded separately, since it returns before reaching this point.)
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
/**
 * Sweep-level alarms, throttled so a persistent outage does not shout every two
 * minutes. Per-order problems already alert on their own; this covers the ways
 * the sweep can fail as a WHOLE, which otherwise look exactly like a quiet day.
 */
let lastSweepAlert = 0;
const SWEEP_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

async function alertSweep(step: string, error: string, humanAction: string): Promise<void> {
  if (Date.now() - lastSweepAlert < SWEEP_ALERT_COOLDOWN_MS) return;
  lastSweepAlert = Date.now();
  await notifySelfServiceFailure({
    flow: 'upsell-merge',
    orderName: 'upsell sweep',
    step,
    error,
    humanAction,
  }).catch(() => undefined);
}

/** Last time we cross-checked an empty result against a count. */
let lastEmptyCrossCheck = 0;
const EMPTY_CROSS_CHECK_MS = 30 * 60 * 1000;

export async function runUpsellMergeSweep(): Promise<SweepSummary> {
  try {
    return await sweep();
  } catch (err) {
    // startLoop would only console.error this, and a sweep that throws every
    // time merges nothing while looking completely silent.
    await alertSweep(
      'run the upsell sweep',
      err instanceof Error ? err.message : String(err),
      'NO upsell orders are being merged while this persists. Check the worker logs.'
    );
    return { scanned: 0, merged: 0, skipped: 0, failed: 0, breakerTripped: true };
  }
}

async function sweep(): Promise<SweepSummary> {
  const empty: SweepSummary = {
    scanned: 0,
    merged: 0,
    skipped: 0,
    failed: 0,
    breakerTripped: false,
  };
  if (!upsellMergeEnabled()) return empty;

  const shopify = await createShopifyClient();
  if (!shopify) {
    await alertSweep(
      'connect to Shopify',
      'No Shopify client - credentials missing or unreadable.',
      'NO upsell orders are being merged. Check the Shopify integration settings.'
    );
    return empty;
  }
  // Fail fast rather than half-work: every merge needs Printify.
  if (!(await createPrintifyClient())) {
    await alertSweep(
      'connect to Printify',
      'No Printify client - credentials missing or unreadable.',
      'NO upsell orders are being merged. Check the Printify token - it expires yearly.'
    );
    return empty;
  }

  const since = new Date(Date.now() - lookbackHours() * 60 * 60 * 1000).toISOString();
  const tag = upsellTag().replace(/'/g, '');
  const query = `tag:'${tag}' AND created_at:>=${since}`;
  const orders = await shopify.getOrdersByQuery(query, 50);

  // getOrdersByQuery SWALLOWS its errors and returns [] - so a Shopify outage
  // is indistinguishable from "no upsells today", which is exactly the silence
  // this whole system is supposed to make impossible. Cross-check an empty
  // result against a count that reports failure honestly (null), rarely enough
  // that it costs nothing.
  if (orders.length === 0 && Date.now() - lastEmptyCrossCheck > EMPTY_CROSS_CHECK_MS) {
    lastEmptyCrossCheck = Date.now();
    const count = await shopify.countOrders(query);
    if (count === null) {
      await alertSweep(
        'read tagged orders from Shopify',
        'Shopify returned nothing AND the cross-check also failed, so the store is unreadable right now.',
        'NO upsell orders are being merged while this persists. Check Shopify API status and the app token.'
      );
    } else if (count > 0) {
      await alertSweep(
        'read tagged orders from Shopify',
        `Shopify says ${count} order(s) carry the upsell tag, but the fetch returned none.`,
        'Upsold items are NOT being merged. The order query is failing silently - check the worker logs.'
      );
    }
  }

  // A full page means there may be more we never saw. Widening the page would
  // just move the cliff; knowing about it is what matters.
  if (orders.length >= 50) {
    await alertSweep(
      'read tagged orders from Shopify',
      'The tagged-order fetch came back full (50), so older upsold orders may be going unseen.',
      'Check for a backlog of unmerged upsold orders, then lower UPSELL_LOOKBACK_HOURS.'
    );
  }

  // Belt and braces: the Shopify tag search is fuzzy, so re-check each order's
  // own tags before it can reach anything that writes.
  const tagged = orders.filter((o) => isUpsellTagged(o.tags));
  if (tagged.length === 0) return { ...empty, scanned: orders.length };

  // Drop the ones settled, in ONE query, BEFORE the breaker. At this store's
  // volume most tagged orders in the window are already done, and counting them
  // would trip the breaker on every sweep.
  //
  // "Settled" is NOT "merged once" - a later order edit can add another item,
  // and that has to be picked up. It is "merged, and untouched on Shopify
  // since". The comparison against Shopify's updatedAt is what keeps this cheap:
  // without it every settled order would cost a live Printify read every two
  // minutes, and Printify has rate-limited this store for exactly that before.
  const done = await prisma.orderRelink.findMany({
    where: {
      shopifyOrderId: { in: tagged.map((o) => o.id) },
      reason: { in: ['UPSELL', 'UPSELL_ADDON'] },
    },
    select: { shopifyOrderId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  const lastMergedAt = new Map<string, Date>();
  for (const d of done) {
    if (!lastMergedAt.has(d.shopifyOrderId)) lastMergedAt.set(d.shopifyOrderId, d.createdAt);
  }
  const now = Date.now();
  const candidates = tagged.filter((o) => {
    const merged = lastMergedAt.get(o.id);
    if (merged && new Date(o.updatedAt).getTime() <= merged.getTime()) return false;

    // Let it settle first. A customer still on the post-purchase page can add
    // another item minutes later, and each rebuild cancels and recreates a real
    // Printify order - so it is worth waiting to do that once.
    const sinceChange = (now - new Date(o.updatedAt).getTime()) / 60000;
    const sincePlaced = (now - new Date(o.createdAt).getTime()) / 60000;
    if (sinceChange < settleMinutes() && sincePlaced < maxSettleMinutes()) return false;

    return true;
  });
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
      reason: { in: ['UPSELL', 'UPSELL_ADDON'] },
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
        // A dry run writes nothing, so nothing remembers this order was already
        // reported - without a throttle it re-announces the same order every two
        // minutes until the channel is unreadable. Which is exactly what
        // happened to #37435 on the first real upsell.
        if (!shouldAlertForOrder(order.id, 'would-merge')) break;
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
      case 'merge-loop':
        summary.failed++;
        if (shouldAlertForOrder(order.id, 'merge-loop')) {
          await notifySelfServiceFailure({
            flow: 'upsell-merge',
            orderName: res.orderName,
            step: 'merge the upsold item',
            error:
              `This order has already been rebuilt ${maxMergesPerOrder()} times and ` +
              'still looks incomplete, which is a loop rather than a customer adding things.',
            humanAction:
              'STOPPED touching this order. Compare it in Shopify and Printify by hand ' +
              'and fix whichever side is wrong.',
            customerEmail: order.customerEmail,
            detail: { shopifyOrderId: order.id },
          });
        }
        break;
      case 'added-second-box': {
        summary.merged++;
        const added = Object.entries(res.added || {})
          .map(([sku, qty]) => `${qty}x ${sku}`)
          .join(', ');
        await selfServiceMonitor({
          text:
            `:package::package: Upsell TOO LATE to merge on ${res.orderName} - the ` +
            `original was already printing, so ${added} is shipping as a SECOND box. ` +
            `The customer gets everything they paid for, in two parcels. The add-on ` +
            `has no tracking line of its own on the Shopify order (pushing one would ` +
            `overwrite the main box's), so tell the customer if they ask.`,
          shopifyOrderId: order.id,
          printifyOrderId: res.newPrintifyOrderId,
          channel: 'upsell',
        });
        break;
      }
      case 'unpaid':
        summary.skipped++;
        if (!shouldAlertForOrder(order.id, 'unpaid')) break;
        await notifySelfServiceFailure({
          flow: 'upsell-merge',
          orderName: res.orderName,
          step: 'merge the upsold item',
          error:
            `The order's outstanding balance is ${order.totalOutstanding ?? 'unknown'}, ` +
            'so the upsold item may not have been charged for.',
          humanAction:
            'NOTHING was sent to print. Check whether the customer was actually ' +
            'charged. If they were, the balance is a Shopify order-edit artefact and ' +
            'the merge will pick it up once it clears.',
          customerEmail: order.customerEmail,
          detail: { shopifyOrderId: order.id },
        });
        break;
      case 'in-production':
        summary.failed++;
        if (!shouldAlertForOrder(order.id, 'in-production')) break;
        await notifySelfServiceFailure({
          flow: 'upsell-merge',
          orderName: res.orderName,
          step: 'merge upsold item into the Printify order',
          error: res.error || 'The Printify order is already in production.',
          humanAction:
            'The second-box fallback did not run. Place the missing item as a ' +
            'separate Printify order by hand, or refund it.',
          customerEmail: order.customerEmail,
          detail: { shopifyOrderId: order.id, added: res.added },
        });
        break;
      case 'rerouted':
        summary.skipped++;
        if (!shouldAlertForOrder(order.id, 'rerouted')) break;
        await notifySelfServiceFailure({
          flow: 'upsell-merge',
          orderName: res.orderName,
          step: 'merge the upsold item',
          error:
            'This order was rerouted to a regional print provider, so rebuilding it ' +
            'would send it back to the default provider.',
          humanAction:
            'Add the upsold item to the rerouted Printify order by hand, keeping the ' +
            'same provider. Nothing was changed.',
          customerEmail: order.customerEmail,
          detail: { shopifyOrderId: order.id },
        });
        break;
      case 'ambiguous-copies':
        summary.skipped++;
        if (!shouldAlertForOrder(order.id, 'ambiguous')) break;
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
        // A create that keeps failing would otherwise shout every two minutes
        // until the channel gets muted, which is how a real alarm gets lost.
        if (!shouldAlertForOrder(order.id, 'failed')) break;
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
      case 'waiting-for-printify': {
        summary.skipped++;
        // Normally Printify is just catching up. But an upsold order with NO
        // live Printify order can also mean its copy was cancelled by something
        // else - the order combiner folding a same-day duplicate into a
        // combined order under a DIFFERENT order's name, say - in which case
        // waiting quietly forever ships the item short and nobody ever knows.
        const ageMin = (Date.now() - new Date(order.createdAt).getTime()) / 60000;
        if (ageMin > STALE_WAIT_MINUTES && shouldAlertForOrder(order.id, 'stale-wait')) {
          await notifySelfServiceFailure({
            flow: 'upsell-merge',
            orderName: res.orderName,
            step: 'find the Printify order to merge the upsell into',
            error:
              `Upsold ${Math.round(ageMin)} min ago and STILL has no live Printify ` +
              'order. Printify should have imported it within minutes.',
            humanAction:
              'Check Printify for this order. If it was folded into a combined ' +
              'order for a same-day duplicate, add the upsold item there by hand. ' +
              'Otherwise the customer is short an item they paid for.',
            customerEmail: order.customerEmail,
            detail: { shopifyOrderId: order.id },
          });
        } else if (upsellDryRun() && shouldAlertForOrder(order.id, 'dry-waiting')) {
          await selfServiceMonitor({
            text:
              `:eyes: DRY RUN - ${res.orderName} is tagged, waiting for Printify ` +
              `to import it (${Math.round(ageMin)} min old). Nothing was changed.`,
            shopifyOrderId: order.id,
            channel: 'upsell',
          });
        }
        break;
      }
      default:
        summary.skipped++;
        // During a dry run, say something about EVERY tagged order. A trial that
        // only speaks up when it wants to act cannot tell "the tag is right and
        // there was nothing to do" apart from "the tag matched nothing at all",
        // and those need very different fixes.
        if (upsellDryRun() && shouldAlertForOrder(order.id, 'dry-nothing')) {
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

  // Take rate is the number the guide says to watch: below ~2% the OFFER is
  // wrong, and no amount of discount fixes the wrong product. Cheap to add here
  // (two counts) and it lands in the same daily line, so it actually gets read.
  let rate = '';
  try {
    const shopify = await createShopifyClient();
    if (shopify) {
      const iso = since.toISOString();
      const tag = upsellTag().replace(/'/g, '');
      const [upsold, total] = await Promise.all([
        shopify.countOrders(`tag:'${tag}' AND created_at:>=${iso}`),
        shopify.countOrders(`created_at:>=${iso}`),
      ]);
      if (upsold !== null && total !== null && total > 0) {
        rate =
          ` Take rate ${((upsold / total) * 100).toFixed(1)}% (${upsold} of ${total} orders).` +
          (upsold / total < 0.02 ? ' Below 2% - change the offered PRODUCT, not the discount.' : '');
      }
    }
  } catch {
    // A missing rate must never cost the heartbeat itself.
  }

  await selfServiceMonitor({
    text:
      `:heartbeat: Upsell merge daily check: running normally. ` +
      `${merged} order(s) merged in the last 24h` +
      (upsellDryRun() ? ' (DRY RUN - nothing is actually being changed).' : '.') +
      rate,
    channel: 'upsell',
  });
}
