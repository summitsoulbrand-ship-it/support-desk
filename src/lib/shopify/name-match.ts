/**
 * Shared customer/order name-matching fallback.
 *
 * Used when a thread's sender email does not match any Shopify customer or
 * order (very common: the buyer emails from a personal address but checked
 * out under a different name/email, or it's a gift). Both the live context
 * route AND the AI draft pipeline use this so the draft sees the SAME order
 * the operator sees in the sidebar - previously the draft matched by email
 * only and flew blind on these, producing confident-but-wrong replies.
 *
 * Matching is deliberately strict (exact name-part equality, exact ship/bill
 * name match) to avoid pulling a stranger's order. A name-only match is never
 * as trustworthy as an email match, so the caller is told the method and
 * should flag it for human double-check.
 */

import type { ShopifyClient } from './client';
import type { ShopifyCustomer, ShopifyOrder } from './types';

export interface NameMatchResult {
  customer: ShopifyCustomer | null;
  orders: ShopifyOrder[];
  /** 'name' = matched a customer record; 'order_name' = matched guest orders */
  method: 'name' | 'order_name';
}

/** A name is usable only if it's a real two-part name, not "support" or "hi". */
export function isValidMatchName(name: string | null | undefined): boolean {
  const parts = name?.trim().split(/\s+/).filter((p) => p.length >= 2) || [];
  return parts.length >= 2 && parts.join(' ').length >= 5;
}

/**
 * Try to find a customer's orders by their name. Returns null when nothing
 * passes the strict checks.
 */
export async function findOrdersByName(
  shopifyClient: ShopifyClient,
  inferredName: string | null | undefined
): Promise<NameMatchResult | null> {
  if (!isValidMatchName(inferredName)) return null;
  const name = inferredName!;

  // 1. Match a customer record by name, then pull their orders.
  try {
    const nameMatch = await shopifyClient.findCustomerByName(name);
    if (nameMatch) {
      const matchedName =
        nameMatch.displayName?.toLowerCase() ||
        `${nameMatch.firstName || ''} ${nameMatch.lastName || ''}`
          .toLowerCase()
          .trim();
      const searchParts = name
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .filter((p) => p.length >= 2);
      const matchedSet = new Set(
        matchedName.split(/\s+/).filter((p) => p.length >= 2)
      );
      // Require BOTH the first AND last name to match exactly. A single shared
      // part is far too weak: a common first name like "Randy" would pull a
      // stranger's order ("Randy Thomas" wrongly matching "Randy Thomasson").
      const firstPart = searchParts[0];
      const lastPart = searchParts[searchParts.length - 1];
      const strongNameMatch =
        searchParts.length >= 2 &&
        firstPart !== lastPart &&
        matchedSet.has(firstPart) &&
        matchedSet.has(lastPart);
      if (strongNameMatch) {
        const orders = await shopifyClient.getCustomerOrders(nameMatch.id, 10);
        if (orders.length > 0) {
          return { customer: nameMatch, orders, method: 'name' };
        }
      }
    }
  } catch (err) {
    console.error('[name-match] customer lookup failed:', err);
  }

  // 2. Guest checkouts: search orders by name and verify the ship/bill name
  //    matches exactly.
  try {
    const cleanedName = name.trim().replace(/\s+/g, ' ');
    const normalizedTarget = cleanedName.toLowerCase();
    const matchesName = (value?: string | null) =>
      !!value && value.trim().toLowerCase() === normalizedTarget;

    const orderMatchesName = (order: ShopifyOrder) => {
      const shippingName = [
        order.shippingAddress?.firstName,
        order.shippingAddress?.lastName,
      ]
        .filter(Boolean)
        .join(' ')
        .trim();
      const billingName = [
        order.billingAddress?.firstName,
        order.billingAddress?.lastName,
      ]
        .filter(Boolean)
        .join(' ')
        .trim();
      return (
        matchesName(shippingName) ||
        matchesName(order.shippingAddress?.name) ||
        matchesName(billingName) ||
        matchesName(order.billingAddress?.name)
      );
    };

    const exactQuery = `"${cleanedName.replace(/"/g, '\\"')}"`;
    let orders = await shopifyClient.getOrdersByQuery(exactQuery, 50);
    if (orders.length === 0) {
      orders = await shopifyClient.getOrdersByQuery(cleanedName, 50);
    }
    let finalMatches = orders.filter(orderMatchesName);

    if (finalMatches.length === 0) {
      const parts = cleanedName.split(' ').filter(Boolean);
      const firstName = parts[0];
      const lastName = parts.slice(1).join(' ');
      if (firstName && lastName) {
        const nameQuery = `first_name:"${firstName.replace(/"/g, '\\"')}" last_name:"${lastName.replace(/"/g, '\\"')}"`;
        const nameOrders = await shopifyClient.getOrdersByQuery(nameQuery, 50);
        finalMatches = nameOrders.filter(orderMatchesName);
      }
    }

    if (finalMatches.length > 0) {
      return { customer: null, orders: finalMatches, method: 'order_name' };
    }
  } catch (err) {
    console.error('[name-match] order lookup failed:', err);
  }

  return null;
}
