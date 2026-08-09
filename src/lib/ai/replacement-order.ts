/**
 * Is this Shopify order a REPLACEMENT we sent, rather than something the
 * customer bought?
 *
 * It matters because the two read identically in a list of orders, and a draft
 * that mistakes one for the other tells a customer we will refund an order they
 * never paid for, or re-promises a replacement they already have.
 *
 * Three signals, strongest first. The desk's own Replace button tags the order
 * "Replacement" and writes "Replacement order for #NNNNN" in the note, so those
 * are reliable - but a replacement created BY HAND in Shopify often carries
 * neither. What it does carry is a total of $0.00, which is Pati's own tell
 * (2026-08-09) and the reason the amount is checked here at all: a customer
 * does not place a zero-dollar order.
 */

import type { ShopifyOrder } from '@/lib/shopify/types';

export type ReplacementSignal = {
  isReplacement: boolean;
  /** The order this one replaces ("#32460"), when we can tell. */
  forOrder: string | null;
  /** Plain-English reason, for the draft context and the operator. */
  why: string | null;
  /** Nothing was charged for this order. */
  freeOfCharge: boolean;
};

const NOT_REPLACEMENT: ReplacementSignal = {
  isReplacement: false,
  forOrder: null,
  why: null,
  freeOfCharge: false,
};

/** "Replacement order for #32460", "replacement for 32460", "reprint for #32460" */
const NOTE_PATTERN = /(?:replacement|reprint|reorder)\s*(?:order\s*)?for\s*#?(\d{3,})/i;

const REPLACEMENT_TAGS = /replacement|reprint|size exchange/i;

export function replacementSignal(order: ShopifyOrder): ReplacementSignal {
  const total = parseFloat(order.totalPrice || '0');
  const freeOfCharge = !isNaN(total) && total === 0;

  const taggedWith = (order.tags || []).find((t) => REPLACEMENT_TAGS.test(t));
  const noteMatch = order.note?.match(NOTE_PATTERN);
  const forOrder = noteMatch ? `#${noteMatch[1]}` : null;

  if (taggedWith || noteMatch) {
    return {
      isReplacement: true,
      forOrder,
      why: taggedWith
        ? `tagged "${taggedWith}"${forOrder ? ` for ${forOrder}` : ''}`
        : `the order note says it replaces ${forOrder}`,
      freeOfCharge,
    };
  }

  // No tag, no note - fall back to the amount. A $0 order with items on it was
  // sent by us, not bought. Kept last so a genuine 100%-off purchase is only
  // ever caught by this weaker signal, never mislabeled by a stale tag.
  if (freeOfCharge && (order.lineItems?.length ?? 0) > 0) {
    return {
      isReplacement: true,
      forOrder: null,
      why: 'a $0 order with items on it - we sent this, the customer did not buy it',
      freeOfCharge: true,
    };
  }

  return NOT_REPLACEMENT;
}

/** Convenience for filtering an order list down to the replacements. */
export function isReplacementOrder(order: ShopifyOrder): boolean {
  return replacementSignal(order).isReplacement;
}
