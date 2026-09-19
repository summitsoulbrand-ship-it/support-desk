/**
 * Idempotency keys for Shopify refunds.
 *
 * From Admin API 2026-04 on, Shopify refuses `refundCreate` unless it carries
 * `@idempotent(key: ...)`. The point of the key is that a refund sent twice
 * moves money once: Shopify remembers a key for 24 hours and answers a repeat
 * with the ORIGINAL result instead of refunding again.
 *
 * That only works if a repeat of the same refund carries the SAME key, so the
 * key is built per LOGICAL refund, never per HTTP attempt. "The same refund
 * again" happens in this app at a level above the HTTP call: a customer retrying
 * the withdrawal link, the payment watcher's next sweep, an agent clicking
 * Refund again after a timeout. Each of those hands in a nonce that was created
 * ONCE, before the first attempt (the portal token id, the pending-change row
 * id, a UUID the refund window made), and the key is derived from it.
 *
 * Measured against the live API on 2026-09-19 (nonexistent order, nothing moved):
 *  - 2025-10 rejects the directive outright ("Directive @idempotent is not
 *    defined"), 2026-01 accepts it as optional, 2026-04 and 2026-07 require it.
 *  - An empty or whitespace key is refused ("cannot be an empty string").
 *  - A request Shopify refuses at validation does not use the key up.
 * From Shopify's docs, not measurable without a real refund: the same key with
 * DIFFERENT parameters is refused (IDEMPOTENCY_KEY_PARAMETER_MISMATCH), and two
 * in flight at once get IDEMPOTENCY_CONCURRENT_REQUEST. Both fail closed.
 */

import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';

/**
 * Namespace for every key the desk derives (UUID v5). NEVER change it: a new
 * namespace silently gives every in-flight refund a new key, which is exactly
 * the double refund this file exists to prevent.
 */
const DESK_KEY_NAMESPACE = '5bb6bb0f-c790-49cb-95b6-9c4d7d98fd87';

export interface RefundIdempotency {
  /**
   * Which flow is refunding, e.g. 'agent-refund'. Keeps two different flows that
   * touch the same order from ever sharing a key.
   */
  action: string;
  /**
   * Created ONCE per logical refund, before the first attempt, and handed in
   * unchanged on every retry of it. Blank or missing means the caller has no
   * such handle: the refund still goes out, under a one-off key, with no
   * protection against a repeat.
   */
  nonce?: string | null;
}

/** The money-defining part of a refund request. */
export interface RefundIntent {
  amount?: string;
  refundShipping?: boolean;
  shippingAmount?: string;
  refundMethod?: 'ORIGINAL' | 'STORE_CREDIT';
  storeCreditExpiresAt?: string;
}

/** '5', '5.0' and '5.00' are the same refund. Non-positive or unreadable = none. */
function money(value?: string): string {
  const n = parseFloat(value ?? '');
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : '';
}

/**
 * The key for one logical refund.
 *
 * Built from WHO is refunding WHAT: order, flow, nonce, and the money the caller
 * asked for. The note and the notify flag are deliberately left out - editing
 * the reason text after a timeout must not mint a fresh key and refund twice.
 * If the amount changes it IS a different refund and gets a different key.
 *
 * It is derived from what the caller ASKED for, not from the RefundInput we end
 * up sending. That input depends on live order state (how the amount is split
 * across tenders), so after a first attempt that really landed it can come out
 * different. Same key + different input is refused by Shopify, which is the
 * safe outcome; a key derived from the input would instead look brand new and
 * go through a second time.
 */
export function refundIdempotencyKey(
  orderId: string,
  idempotency: RefundIdempotency,
  intent: RefundIntent = {}
): string {
  const nonce = (idempotency.nonce ?? '').trim();
  if (!nonce) {
    // Never derive from a blank nonce: every refund of the same amount on the
    // same order would then share one key, and the second would come back as a
    // cached "success" with no money moved.
    return uuidv4();
  }

  const shipping = intent.refundShipping ? money(intent.shippingAmount) || 'FULL' : '';
  const parts = [
    'refundCreate',
    orderId,
    idempotency.action,
    nonce,
    money(intent.amount),
    shipping,
    intent.refundMethod || 'ORIGINAL',
    intent.storeCreditExpiresAt || '',
  ];
  return uuidv5(JSON.stringify(parts), DESK_KEY_NAMESPACE);
}

/** Shown to a person whenever we cannot say whether a refund went through. */
export const REFUND_UNCONFIRMED_WARNING =
  'Shopify did not confirm this refund, so it may or may not have gone through. Check the order in Shopify before trying again.';

/**
 * Is this refundCreate userError Shopify saying "I have already seen this key"?
 *
 * Two documented answers: the same key is still being processed ("This request
 * is currently in progress, please try again"), or it arrived before with other
 * parameters ("The same idempotency key cannot be used with different operation
 * parameters"). Either way an EARLIER attempt reached Shopify, so this is not a
 * clean refusal: the refund may exist. The key must be kept, not replaced - a
 * fresh key here is how a third click would refund twice.
 *
 * refundCreate's userErrors carry no error code (plain field + message), and
 * these answers cannot be provoked without a real refund, so this matches the
 * documented wording loosely. A miss falls back to today's behavior.
 */
export function isIdempotencyConflict(message: string): boolean {
  return /idempoten|currently in progress/i.test(message);
}

/**
 * After a failed refundCreate call: could Shopify have processed it anyway?
 *
 * True means we do not know - the request may have landed and only the answer
 * was lost (timeout, dropped connection, a 5xx). That is the one case where a
 * retry MUST reuse the same key. False means Shopify answered and refused
 * before running anything (4xx, a GraphQL validation or throttle error), so
 * nothing moved and a retry is a fresh attempt.
 *
 * Reads the error messages ShopifyClient.graphql throws.
 */
export function refundOutcomeUnknown(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);

  const http = message.match(/^Shopify API error: (\d{3})/);
  if (http) return !http[1].startsWith('4');

  if (message.startsWith('GraphQL errors:')) {
    return /INTERNAL_SERVER_ERROR|TIMEOUT/i.test(message);
  }

  return true;
}
