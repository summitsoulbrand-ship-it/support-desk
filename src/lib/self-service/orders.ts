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
  | 'too_late_unverified';

export interface Eligibility {
  eligible: boolean;
  reason: EligibilityReason;
}

export interface OrderState {
  shopifyOrder: ShopifyOrder;
  printifyOrderId: string | null;
  printifyOrder: PrintifyOrder | null;
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

export type WithdrawEligibilityReason = 'ok' | 'already_cancelled' | 'outside_window';

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
    case 'outside_window':
      return 'This order is outside the window we can process automatically. Reply to this email or contact support@summitsoul.shop and we will sort out your withdrawal.';
    default:
      return '';
  }
}

/** Decide whether a cancel is still allowed. Pure - takes already-fetched data. */
export function computeEligibility(
  shopifyOrder: ShopifyOrder,
  printifyOrder: PrintifyOrder | null
): Eligibility {
  if (shopifyOrder.cancelledAt) {
    return { eligible: false, reason: 'already_cancelled' };
  }

  const fulfilled = isFulfilled(shopifyOrder);

  if (printifyOrder) {
    // Authoritative production check.
    if (!PrintifyClient.canCancelOrder(printifyOrder)) {
      return { eligible: false, reason: 'in_production' };
    }
    if (fulfilled) {
      return { eligible: false, reason: 'already_fulfilled' };
    }
    return { eligible: true, reason: 'ok' };
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

/** Find the Printify order id linked to a Shopify order via the cache. */
export async function resolvePrintifyOrderId(
  shopifyOrder: ShopifyOrder
): Promise<string | null> {
  const candidates = [
    shopifyOrder.name,
    shopifyOrder.name?.replace('#', ''),
    shopifyOrder.orderNumber?.toString(),
    shopifyOrder.legacyResourceId,
    shopifyOrder.id?.replace('gid://shopify/Order/', ''),
  ].filter(Boolean) as string[];

  if (candidates.length === 0) return null;

  const cached = await prisma.printifyOrderCache.findFirst({
    where: {
      OR: [
        { externalId: { in: candidates } },
        { label: { in: candidates } },
        { metadataShopOrderId: { in: candidates } },
        { metadataShopOrderLabel: { in: candidates } },
      ],
    },
    orderBy: { updatedAt: 'desc' },
  });
  return cached?.id ?? null;
}

function emailMatches(order: ShopifyOrder, email: string): boolean {
  const target = email.trim().toLowerCase();
  return order.customerEmail?.toLowerCase() === target;
}

/**
 * Initial lookup by order number + email (the request-link form). Returns null
 * if the order does not exist OR the email does not match the order - callers
 * MUST treat both the same (no existence disclosure).
 */
export async function lookupOrderByNumberAndEmail(
  orderNumber: string,
  email: string
): Promise<OrderState | null> {
  const shopify = await createShopifyClient();
  if (!shopify) return null;

  const order = await shopify.getOrderByNumber(orderNumber.trim());
  if (!order) return null;
  if (!emailMatches(order, email)) return null;

  const printifyOrderId = await resolvePrintifyOrderId(order);
  let printifyOrder: PrintifyOrder | null = null;
  if (printifyOrderId) {
    const printify = await createPrintifyClient();
    printifyOrder = printify ? await printify.getOrder(printifyOrderId) : null;
  }

  return {
    shopifyOrder: order,
    printifyOrderId,
    printifyOrder,
    eligibility: computeEligibility(order, printifyOrder),
  };
}

/**
 * Re-load LIVE order state from a token (preview + execution). Re-fetches
 * Shopify by gid and Printify by id so the cutoff is checked at the real moment
 * of action, not when the page was first opened.
 */
export async function loadOrderStateForToken(token: {
  shopifyOrderId: string;
  printifyOrderId: string | null;
}): Promise<OrderState | null> {
  const shopify = await createShopifyClient();
  if (!shopify) return null;

  const order = await shopify.getOrderById(token.shopifyOrderId);
  if (!order) return null;

  // Re-resolve the Printify link in case it appeared after the link was minted.
  const printifyOrderId =
    token.printifyOrderId || (await resolvePrintifyOrderId(order));
  let printifyOrder: PrintifyOrder | null = null;
  if (printifyOrderId) {
    const printify = await createPrintifyClient();
    printifyOrder = printify ? await printify.getOrder(printifyOrderId) : null;
  }

  return {
    shopifyOrder: order,
    printifyOrderId,
    printifyOrder,
    eligibility: computeEligibility(order, printifyOrder),
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
    default:
      return '';
  }
}
