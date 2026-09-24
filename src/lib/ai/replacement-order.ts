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

import type { ReprintSummary } from '@/lib/printify/reprint';
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

/**
 * A replacement printed straight in Printify (a reprint) as a line in the
 * draft's "replacements that already exist" list. It has no Shopify order
 * number, so the customer hears about it through the order it replaces; the
 * Printify number is ours alone.
 */
export function reprintAsExistingReplacement(r: ReprintSummary): {
  replacementOrder: string;
  forOrder: string;
  createdAt: string;
  fulfillmentStatus: string;
  items: string[];
  howWeKnow: string;
  freeOfCharge: boolean;
  tracking?: string;
} {
  const on = (iso?: string | null) => (iso ? ` on ${iso.slice(0, 10)}` : '');
  const status =
    r.stage === 'delivered'
      ? `DELIVERED${on(r.tracking?.deliveredAt)}`
      : r.stage === 'shipped'
        ? `SHIPPED${on(r.tracking?.shippedAt)} - on its way to the customer`
        : r.stage === 'printing'
          ? 'PRINTING - not shipped yet'
          : 'MADE BUT NOT PRINTING YET - waiting in Printify, not shipped';
  return {
    replacementOrder: `A replacement printed directly by our print partner, with no order number of its own`,
    forOrder: r.forOrderName,
    createdAt: r.createdAt,
    fulfillmentStatus: status,
    items: r.items,
    howWeKnow: `Printify reprint ${r.appOrderId || r.printifyOrderId} - an internal reference, never give it to the customer`,
    // The customer paid nothing for it.
    freeOfCharge: true,
    tracking: r.tracking
      ? `${r.tracking.carrier} ${r.tracking.number}${r.tracking.url ? ` (${r.tracking.url})` : ''}`
      : undefined,
  };
}
