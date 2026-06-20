/**
 * The ONE order-matching cascade, shared by the AI draft pipeline and the
 * sidebar context route, so a draft always sees the SAME order the operator
 * sees in the sidebar. Previously these were two separate implementations that
 * drifted: the sidebar matched almost every order (email -> guest email ->
 * name -> receipt) while the draft ran a thinner cascade under a single
 * try/catch, so one Shopify hiccup blinded it and it produced a confident
 * "I don't have your order details" reply.
 *
 * Each strategy here is isolated in its own try/catch: a timeout or rate-limit
 * in one step never aborts the others. Order of preference is most-trustworthy
 * first - an email match needs no caveat; a name / receipt / order-number match
 * is flagged unverified so the caller can ask a human to double-check before
 * any account change.
 */

import { createShopifyClient } from '@/lib/shopify';
import type { ShopifyClient } from '@/lib/shopify/client';
import type { ShopifyCustomer, ShopifyOrder } from '@/lib/shopify/types';
import { findOrdersByName, isValidMatchName } from '@/lib/shopify/name-match';
import { resolveReceiptOrder } from '@/lib/ai/receipt-extract';

export type OrderMatchMethod = 'email' | 'name' | 'order_name';

export interface ThreadOrderMatch {
  customer: ShopifyCustomer | null;
  orders: ShopifyOrder[];
  method: OrderMatchMethod;
  /**
   * Non-null when the match is NOT email-verified (matched by name, an attached
   * receipt, or the order number in the message body). A caller-facing caveat
   * to surface so changes get a human double-check. Null for email matches.
   */
  unverifiedReason: string | null;
}

export interface ResolveThreadOrdersOpts {
  /** Reuse an existing client when the caller already has one; else one is made. */
  shopifyClient?: ShopifyClient | null;
  email: string;
  inferredName?: string | null;
  /** Needed for the attached-receipt fallback. */
  threadId?: string;
  latestInboundMessageId?: string | null;
  /** Triage entities carry the receipt order number AND any order number the
   *  triage read off the message body (used by the last fallback). */
  triageEntities?: Record<string, unknown> | null;
  hasTriageRow?: boolean;
}

/**
 * Run the full order-matching cascade. Returns the first strategy that yields
 * orders, or null when nothing matches.
 */
export async function resolveThreadOrders(
  opts: ResolveThreadOrdersOpts
): Promise<ThreadOrderMatch | null> {
  const client = opts.shopifyClient ?? (await createShopifyClient());
  if (!client) return null;
  const { email, inferredName } = opts;

  // 1. Shopify customer record by email (most trustworthy).
  try {
    const data = await client.getCustomerWithOrders(email, 10);
    if (data && data.orders.length > 0) {
      return { customer: data.customer, orders: data.orders, method: 'email', unverifiedReason: null };
    }
  } catch (err) {
    console.error('[order-resolve] customer-by-email failed:', err);
  }

  // 2. Guest checkout: orders carry the email with no customer account.
  try {
    const orders = await client.getOrdersByEmail(email, 10);
    if (orders.length > 0) {
      return { customer: null, orders, method: 'email', unverifiedReason: null };
    }
  } catch (err) {
    console.error('[order-resolve] guest-orders-by-email failed:', err);
  }

  // 3. Name match - the sender emailed from a different address than checkout.
  if (isValidMatchName(inferredName)) {
    try {
      const byName = await findOrdersByName(client, inferredName);
      if (byName && byName.orders.length > 0) {
        return {
          customer: byName.customer,
          orders: byName.orders,
          method: byName.method,
          unverifiedReason:
            'matched by customer NAME (sender email did not match) - confirm the order number before promising any change',
        };
      }
    } catch (err) {
      console.error('[order-resolve] name match failed:', err);
    }
  }

  // 4. Attached receipt - read the order number off a PDF/image (cached on the
  //    triage row, so the vision call runs at most once per thread).
  if (opts.threadId && opts.latestInboundMessageId) {
    try {
      const receipt = await resolveReceiptOrder({
        threadId: opts.threadId,
        latestInboundMessageId: opts.latestInboundMessageId,
        triageEntities: opts.triageEntities ?? null,
        hasTriageRow: !!opts.hasTriageRow,
      });
      if (receipt && receipt.orders.length > 0) {
        return {
          customer: null,
          orders: receipt.orders,
          method: 'order_name',
          unverifiedReason: `matched from the attached receipt (#${receipt.orderNumber}) - the sender's email/name did not match, so verify this is the right order before any change`,
        };
      }
    } catch (err) {
      console.error('[order-resolve] receipt match failed:', err);
    }
  }

  // 5. Order number the triage read off the message body itself.
  const triageOrderNumber = (
    opts.triageEntities as { orderNumber?: string } | null
  )?.orderNumber;
  if (triageOrderNumber) {
    try {
      const order = await client.getOrderByNumber(triageOrderNumber);
      if (order) {
        return {
          customer: null,
          orders: [order],
          method: 'order_name',
          unverifiedReason: `matched by the order number in the message (#${triageOrderNumber}) - the sender's email/name did not match, so verify this is the right order before any change`,
        };
      }
    } catch (err) {
      console.error('[order-resolve] order-number match failed:', err);
    }
  }

  return null;
}
