/**
 * Order lookup + "is this still cancellable?" logic for the self-service portal.
 *
 * The production cutoff is the same one the support desk enforces:
 *  - if a linked Printify order exists, PrintifyClient.canCancelOrder() is
 *    authoritative (false once sent_to_production_at / any item in production).
 *  - if NO Printify order can be found, we cannot verify production state, so we
 *    fall back to a conservative gate (unfulfilled AND within the safety window)
 *    and otherwise send the customer to support rather than risk refunding an
 *    order that is already being printed.
 *
 * Every action route re-runs this against LIVE data at click-time - never trust
 * the state the page was rendered with.
 */

import prisma from '@/lib/db';
import { createShopifyClient } from '@/lib/shopify';
import { createPrintifyClient, PrintifyClient } from '@/lib/printify';
import type { ShopifyOrder } from '@/lib/shopify/types';
import type { PrintifyOrder } from '@/lib/printify/types';

// Fallback window when there is no Printify order to check against. Printify
// auto-sends orders to production ~11pm PT, so anything older is assumed locked.
const UNVERIFIED_SAFETY_HOURS = 12;

export type EligibilityReason =
  | 'ok'
  | 'already_cancelled'
  | 'in_production'
  | 'already_fulfilled'
  | 'too_late_unverified'
  | 'needs_support';

export interface Eligibility {
  eligible: boolean;
  reason: EligibilityReason;
}

/**
 * One Printify copy of the order. `order` is the LIVE-fetched Printify order;
 * null means the live read failed, which must be treated as "cannot verify"
 * (fail closed), never as "fine".
 */
export interface PrintifyCopy {
  id: string;
  order: PrintifyOrder | null;
}

export interface OrderState {
  shopifyOrder: ShopifyOrder;
  /**
   * ALL live (non-cancelled) Printify copies of this order. A Shopify order can
   * map to more than one Printify order (an address-change or item-change
   * recreate, a manual replacement, a reroute) - every action must consider all
   * of them, never just "the" one.
   */
  printifyOrders: PrintifyCopy[];
  /** Cancelled Printify copies found for this order (replacement breadcrumbs). */
  cancelledCopies: number;
  /** First live copy's id - stored on tokens for the audit trail. */
  printifyOrderId: string | null;
  eligibility: Eligibility;
}

function hasTracking(order: ShopifyOrder): boolean {
  return (order.fulfillments || []).some(
    (f) => !!f && f.status !== 'CANCELLED'
  );
}

/** Has the order entered fulfillment (printed / shipped / tracking exists)? */
export function isFulfilled(order: ShopifyOrder): boolean {
  return (
    order.fulfillmentStatus === 'FULFILLED' ||
    order.fulfillmentStatus === 'PARTIALLY_FULFILLED' ||
    order.fulfillmentStatus === 'IN_PROGRESS' ||
    hasTracking(order)
  );
}

// --- EU right of withdrawal --------------------------------------------------
// EU-27 (ISO 3166-1 alpha-2). Consumers shipping to these countries get the
// statutory 14-day right of withdrawal (Directive 2011/83/EU, withdrawal-button
// duty added by Directive (EU) 2023/2673, applicable 19 Jun 2026). The regime is
// keyed off the ORDER's ship-to country, never the browser IP.
const EU_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
]);

export function isEuOrder(order: ShopifyOrder): boolean {
  const cc = order.shippingAddress?.countryCode?.toUpperCase();
  return !!cc && EU_COUNTRY_CODES.has(cc);
}

// The statutory period is 14 days from delivery. Made-to-order international
// delivery runs ~1-3 weeks, so 45 days from the order date is a generous proxy
// that always covers "delivery + 14 days". Within the window the portal
// processes the withdrawal + refund automatically; outside it, the request is
// recorded and routed to support rather than auto-refunding a very old order.
const WITHDRAW_WINDOW_DAYS = 45;

export type WithdrawEligibilityReason =
  | 'ok'
  | 'already_cancelled'
  | 'already_refunded'
  | 'outside_window';

export interface WithdrawEligibility {
  eligible: boolean;
  reason: WithdrawEligibilityReason;
}

/**
 * EU withdrawal eligibility. Unlike a cancel, withdrawal is NOT blocked by
 * production or fulfillment state - the consumer may withdraw within 14 days of
 * delivery even after the item ships. Only an already-cancelled order or an
 * order past the generous auto-process window is held back.
 */
export function computeWithdrawEligibility(order: ShopifyOrder): WithdrawEligibility {
  if (order.cancelledAt) return { eligible: false, reason: 'already_cancelled' };
  // Money already went back (fully refunded / voided / partially refunded) -
  // the auto-flow issues a FULL refund, so processing again would double-pay.
  // Partial refunds go to support instead of risking an over-refund.
  const financial = (order.financialStatus || '').toUpperCase();
  if (
    financial === 'REFUNDED' ||
    financial === 'VOIDED' ||
    financial === 'PARTIALLY_REFUNDED'
  ) {
    return { eligible: false, reason: 'already_refunded' };
  }
  const ageMs = Date.now() - new Date(order.createdAt).getTime();
  if (ageMs > WITHDRAW_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
    return { eligible: false, reason: 'outside_window' };
  }
  return { eligible: true, reason: 'ok' };
}

/** Human-friendly copy for why a withdrawal can't be auto-processed. */
export function withdrawReasonMessage(reason: WithdrawEligibilityReason): string {
  switch (reason) {
    case 'already_cancelled':
      return 'This order has already been cancelled, so there is nothing to withdraw.';
    case 'already_refunded':
      return 'This order has already been refunded, so there is nothing left to withdraw. If something looks off, contact support@summitsoul.shop and we will help.';
    case 'outside_window':
      return 'This order is outside the window we can process automatically. Reply to this email or contact support@summitsoul.shop and we will sort out your withdrawal.';
    default:
      return '';
  }
}

/**
 * Decide whether a cancel is still allowed. Pure - takes already-fetched data.
 *
 * Fail closed on every ambiguity:
 *  - EVERY live Printify copy must be verifiably pre-production. One copy that
 *    can't be read (order: null) or has entered production blocks the whole
 *    order - cancelling "most" of an order refunds a customer whose remaining
 *    copy still prints and ships.
 *  - No live copy but cancelled copies exist -> a replacement/recreate is (or
 *    was) in flight somewhere we can't see. Route to support instead of
 *    guessing.
 *  - No Printify trace at all -> brand new order; conservative age window.
 */
export function computeEligibility(
  shopifyOrder: ShopifyOrder,
  printifyOrders: PrintifyCopy[],
  cancelledCopies: number
): Eligibility {
  if (shopifyOrder.cancelledAt) {
    return { eligible: false, reason: 'already_cancelled' };
  }

  const fulfilled = isFulfilled(shopifyOrder);

  if (printifyOrders.length > 0) {
    // Authoritative production check across ALL live copies.
    for (const copy of printifyOrders) {
      if (!copy.order) {
        return { eligible: false, reason: 'needs_support' };
      }
      if (!PrintifyClient.canCancelOrder(copy.order)) {
        return { eligible: false, reason: 'in_production' };
      }
    }
    if (fulfilled) {
      return { eligible: false, reason: 'already_fulfilled' };
    }
    return { eligible: true, reason: 'ok' };
  }

  if (cancelledCopies > 0) {
    return { eligible: false, reason: 'needs_support' };
  }

  // No Printify order to verify against - be conservative.
  if (fulfilled) {
    return { eligible: false, reason: 'already_fulfilled' };
  }
  const ageMs = Date.now() - new Date(shopifyOrder.createdAt).getTime();
  if (ageMs > UNVERIFIED_SAFETY_HOURS * 60 * 60 * 1000) {
    return { eligible: false, reason: 'too_late_unverified' };
  }
  return { eligible: true, reason: 'ok' };
}

const isCancelledStatus = (s?: string | null) =>
  !!s && /^cancell?ed$/i.test(s.trim());

/**
 * Find ALL Printify orders linked to a Shopify order.
 *
 * The cache (webhook-fed) supplies the candidate ids; each candidate the cache
 * does not already show as cancelled is then re-read LIVE from Printify, so
 * eligibility never trusts a stale status. (Cancellation is terminal on
 * Printify, so cache-cancelled rows are counted without burning an API call.)
 * A live read that fails yields { order: null } - the caller must fail closed.
 */
export async function resolvePrintifyOrders(
  shopifyOrder: ShopifyOrder,
  opts?: {
    /**
     * 'live' (default): re-read every non-cancelled copy from Printify - REQUIRED
     * before any action. 'cache': trust the webhook-fed cache row - fine for the
     * read-only status view (Printify rate-limited us once for hammering live
     * reads on page views; actions still re-check live at click time).
     */
    source?: 'live' | 'cache';
  }
): Promise<{ live: PrintifyCopy[]; cancelledCopies: number }> {
  const source = opts?.source ?? 'live';
  const candidates = [
    shopifyOrder.name,
    shopifyOrder.name?.replace('#', ''),
    shopifyOrder.orderNumber?.toString(),
    shopifyOrder.legacyResourceId,
    shopifyOrder.id?.replace('gid://shopify/Order/', ''),
  ].filter(Boolean) as string[];

  if (candidates.length === 0) return { live: [], cancelledCopies: 0 };

  const rows = await prisma.printifyOrderCache.findMany({
    where: {
      OR: [
        { externalId: { in: candidates } },
        { label: { in: candidates } },
        { metadataShopOrderId: { in: candidates } },
        { metadataShopOrderLabel: { in: candidates } },
      ],
    },
    orderBy: { createdAt: 'asc' },
  });
  if (rows.length === 0) return { live: [], cancelledCopies: 0 };

  const printify = source === 'live' ? await createPrintifyClient() : null;
  let cancelledCopies = 0;
  const live: PrintifyCopy[] = [];
  for (const row of rows) {
    if (isCancelledStatus(row.status)) {
      cancelledCopies++;
      continue;
    }
    let order: PrintifyOrder | null = null;
    if (source === 'cache') {
      const cached = row.data as unknown as PrintifyOrder | null;
      // A cache row without line items (minimal create payload) can't be
      // trusted for a production check - leave order null (fail closed).
      order = cached && Array.isArray(cached.line_items) ? cached : null;
    } else {
      order = printify ? await printify.getOrder(row.id) : null;
    }
    if (order && isCancelledStatus(order.status)) {
      cancelledCopies++;
      continue;
    }
    live.push({ id: row.id, order });
  }
  return { live, cancelledCopies };
}

// --- Portal status view -------------------------------------------------------

export type PortalStatus =
  | 'cancelled'
  | 'shipped'
  | 'printing'
  | 'editable'
  | 'needs_support';

export interface TrackingLink {
  number: string;
  url?: string;
  carrier?: string;
}

/** Copy shown wherever the customer can still act - and why there's a clock. */
export const PRODUCTION_DEADLINE_COPY =
  'Orders go to print around 11pm Pacific on the day they are placed. Until then you can change or cancel your order below; once printing starts it is locked.';

/**
 * Collapse Shopify + Printify state into the one line a customer cares about.
 * Sequence matters: cancelled -> shipped -> (from cancel eligibility) editable /
 * printing / needs a human.
 */
export function derivePortalStatus(state: OrderState): {
  status: PortalStatus;
  tracking: TrackingLink[];
} {
  const o = state.shopifyOrder;
  const tracking: TrackingLink[] = (o.fulfillments || [])
    .filter((f) => f.status !== 'CANCELLED' && f.trackingNumber)
    .map((f) => ({
      number: f.trackingNumber as string,
      url: f.trackingUrl,
      carrier: f.trackingCompany,
    }));

  if (o.cancelledAt) return { status: 'cancelled', tracking };
  if (isFulfilled(o)) return { status: 'shipped', tracking };
  if (state.eligibility.eligible) return { status: 'editable', tracking };
  switch (state.eligibility.reason) {
    case 'needs_support':
      return { status: 'needs_support', tracking };
    default:
      // in_production / too_late_unverified: locked, being made.
      return { status: 'printing', tracking };
  }
}

function emailMatches(order: ShopifyOrder, email: string): boolean {
  const target = email.trim().toLowerCase();
  return order.customerEmail?.toLowerCase() === target;
}

/**
 * Result of the request-link lookup. We distinguish "no order with that number
 * exists at all" from "an order exists but the email doesn't match" so the route
 * can give a helpful "we couldn't find that order" message for the former while
 * staying generic for the latter (never confirming a real order's email).
 *  - 'not_found'      : no order with that number (safe to tell the customer)
 *  - 'email_mismatch' : order exists, email wrong -> caller MUST stay generic
 *  - 'unavailable'    : Shopify couldn't be reached -> caller stays generic
 *  - 'ok'             : order + email matched
 */
export type OrderLookupResult =
  | { status: 'not_found' }
  | { status: 'email_mismatch' }
  | { status: 'unavailable' }
  | { status: 'ok'; state: OrderState };

/**
 * Initial lookup by order number + email (the request-link form).
 */
export async function lookupOrderByNumberAndEmail(
  orderNumber: string,
  email: string
): Promise<OrderLookupResult> {
  const shopify = await createShopifyClient();
  if (!shopify) return { status: 'unavailable' };

  const order = await shopify.getOrderByNumber(orderNumber.trim());
  if (!order) return { status: 'not_found' };
  if (!emailMatches(order, email)) return { status: 'email_mismatch' };

  const { live, cancelledCopies } = await resolvePrintifyOrders(order);

  return {
    status: 'ok',
    state: {
      shopifyOrder: order,
      printifyOrders: live,
      cancelledCopies,
      printifyOrderId: live[0]?.id ?? null,
      eligibility: computeEligibility(order, live, cancelledCopies),
    },
  };
}

/**
 * Re-load LIVE order state from a token (preview + execution). Re-fetches
 * Shopify by gid and Printify by id so the cutoff is checked at the real moment
 * of action, not when the page was first opened.
 */
export async function loadOrderStateForToken(
  token: {
    shopifyOrderId: string;
    printifyOrderId: string | null;
  },
  opts?: { source?: 'live' | 'cache' }
): Promise<OrderState | null> {
  const shopify = await createShopifyClient();
  if (!shopify) return null;

  const order = await shopify.getOrderById(token.shopifyOrderId);
  if (!order) return null;

  // Always re-resolve ALL Printify copies fresh - the token's stored id is an
  // audit breadcrumb, not a source of truth (new copies can appear after the
  // link was minted, e.g. a replacement recreate).
  const { live, cancelledCopies } = await resolvePrintifyOrders(order, opts);

  return {
    shopifyOrder: order,
    printifyOrders: live,
    cancelledCopies,
    printifyOrderId: live[0]?.id ?? null,
    eligibility: computeEligibility(order, live, cancelledCopies),
  };
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const shown = local.slice(0, 2);
  return `${shown}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

/** Human-friendly copy for why a cancel is blocked. */
export function reasonMessage(reason: EligibilityReason): string {
  switch (reason) {
    case 'already_cancelled':
      return 'This order has already been cancelled.';
    case 'in_production':
    case 'too_late_unverified':
      return 'This order has already started printing, so it can no longer be cancelled automatically. Reply to this email or contact support@summitsoul.shop and we will help.';
    case 'already_fulfilled':
      return 'This order has already shipped, so it can no longer be cancelled. Contact support@summitsoul.shop if you need help.';
    case 'needs_support':
      return 'This order needs a quick human check before it can be changed. Reply to this email or contact support@summitsoul.shop and we will sort it out right away.';
    default:
      return '';
  }
}
