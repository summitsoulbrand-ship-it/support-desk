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

/** Decide whether a cancel is still allowed. Pure - takes already-fetched data. */
export function computeEligibility(
  shopifyOrder: ShopifyOrder,
  printifyOrder: PrintifyOrder | null
): Eligibility {
  if (shopifyOrder.cancelledAt) {
    return { eligible: false, reason: 'already_cancelled' };
  }

  const fulfilled =
    shopifyOrder.fulfillmentStatus === 'FULFILLED' ||
    shopifyOrder.fulfillmentStatus === 'PARTIALLY_FULFILLED' ||
    shopifyOrder.fulfillmentStatus === 'IN_PROGRESS' ||
    hasTracking(shopifyOrder);

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
