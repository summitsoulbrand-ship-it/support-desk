/**
 * Printify reprints -> the original Shopify order.
 *
 * A reprint made in Printify (by us, or by Printify support on request) is a
 * brand-new MANUAL order with no Shopify link - no shop_order_id, no label - so
 * Printify's store sync never sends its tracking to Shopify and the customer
 * gets no shipping email for the new parcel. Printify does mark it:
 * metadata.is_reprint = true and metadata.reprinted_order_ids = [parent], and
 * the parent still names its Shopify order. Measured 2026-09-24: 43 reprints
 * since 08-10, every one pointing at a parent with a Shopify order, and not one
 * of the 40 that had shipped had its tracking in Shopify. Before 08-10 some
 * were linked by hand with "I already handled this in Printify".
 *
 * Linking one is the same OrderRelink row the hand link writes (reason
 * REPLACEMENT). The relink push then swaps the new tracking onto the original
 * fulfillment with a shipping-update email, and Shopify follows the new parcel
 * itself from there - its "out for delivery" and "delivered" emails included
 * (seen on #23849, #27653 and #24143 after a replacement's tracking swap).
 *
 * Pure logic only: the database and API reads come in through ReprintDeps, so
 * this runs the same against fakes and against real orders.
 */

import type { PrintifyAddress, PrintifyOrder } from './types';

/**
 * Only reprints this young are linked. A new reprint is linked on the first
 * relink poll after it appears, days before it ships; the window only decides
 * how far back the first run reaches. Older ones reached the customer long ago
 * or are stuck, and a shipping email about them now would be noise.
 */
export const REPRINT_LINK_WINDOW_DAYS = 21;

/** The order this one reprints, or null when it is not a reprint. */
export function reprintParentId(order: PrintifyOrder): string | null {
  const md = order.metadata;
  if (!md?.is_reprint) return null;
  return md.reprinted_order_ids?.[0] || null;
}

/**
 * The Shopify order name inside a Printify label. "#30307 (combined)" is the
 * order combiner's label for one customer's same-day orders shipped as one
 * box, filed under the earliest order, so that order is the one to update.
 */
export function shopifyNameFromLabel(label?: string | null): string | null {
  const m = /^#(\d+)\b/.exec((label || '').trim());
  return m ? `#${m[1]}` : null;
}

export type ReprintSkip = 'not-a-reprint' | 'cancelled' | 'delivered' | 'too-old';

/**
 * Why a reprint should be left alone, or null to link it. Delivered is judged
 * on the reprint's OWN parcels: once they have arrived, a shipping email is
 * news the customer no longer needs.
 */
export function reprintSkipReason(
  order: PrintifyOrder,
  now: Date = new Date()
): ReprintSkip | null {
  if (!reprintParentId(order)) return 'not-a-reprint';
  if (/^cancell?ed$/i.test(order.status || '')) return 'cancelled';
  const shipments = order.shipments || [];
  if (shipments.length > 0 && shipments.every((s) => s.delivered_at)) return 'delivered';
  // Printify writes "2026-09-18 01:33:07+00:00"
  const created = Date.parse(String(order.created_at || '').replace(' ', 'T'));
  if (
    Number.isFinite(created) &&
    now.getTime() - created > REPRINT_LINK_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ) {
    return 'too-old';
  }
  return null;
}

function zipKey(zip?: string): string {
  const z = (zip || '').toUpperCase().replace(/\s+/g, '');
  return /^\d{5}(-?\d{4})?$/.test(z) ? z.slice(0, 5) : z;
}

function personName(a?: PrintifyAddress): string {
  const n = `${a?.first_name || ''} ${a?.last_name || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  // Printify blanks names and emails about 30 days after an order.
  return n.includes('pii_deleted') ? '' : n;
}

/**
 * Is the reprint going to the customer of the order it reprints? Same ZIP, or
 * the same name at a new address - 42 of the 43 measured reprints kept the
 * ZIP, the 43rd kept the name. Anything else (a reprint sent to ourselves as a
 * sample, say) must not email the original customer tracking for a parcel that
 * is not theirs.
 */
export function sameRecipient(reprint?: PrintifyAddress, parent?: PrintifyAddress): boolean {
  const za = zipKey(reprint?.zip);
  if (za && za === zipKey(parent?.zip)) return true;
  const na = personName(reprint);
  return !!na && na === personName(parent);
}

export interface ReprintDeps {
  /** A Printify order by id, or null when it cannot be read. */
  getOrder(id: string): Promise<PrintifyOrder | null>;
  /** A Shopify order by gid, or null when there is none. */
  getShopifyOrderById(gid: string): Promise<{ id: string; name: string } | null>;
  /** A Shopify order by its name ("#38075"), or null when there is none. */
  getShopifyOrderByName(name: string): Promise<{ id: string; name: string } | null>;
}

export type ReprintTarget =
  | { ok: true; parentId: string; shopifyOrderId: string; shopifyOrderName: string }
  | { ok: false; reason: string };

/**
 * The Shopify order a reprint belongs to. Follows Printify's own link, never a
 * guess: reprint -> the order it reprints (-> further up while that is itself
 * an unlabelled reprint) -> the Shopify order that order names.
 */
export async function resolveReprintTarget(
  reprint: PrintifyOrder,
  deps: ReprintDeps
): Promise<ReprintTarget> {
  const parentId = reprintParentId(reprint);
  if (!parentId) return { ok: false, reason: 'not a reprint' };

  const parent = await deps.getOrder(parentId);
  if (!parent) return { ok: false, reason: `original Printify order ${parentId} could not be read` };
  if (!sameRecipient(reprint.address_to, parent.address_to)) {
    return { ok: false, reason: 'ships to a different person and address than the original' };
  }

  // A reprint of a reprint has no Shopify label of its own - walk up to the
  // order that has one.
  let linked: PrintifyOrder | null = parent;
  for (let hop = 0; linked && !linked.metadata?.shop_order_label && hop < 3; hop++) {
    const upId = reprintParentId(linked);
    linked = upId ? await deps.getOrder(upId) : null;
  }
  const label = linked?.metadata?.shop_order_label;
  if (!linked || !label) return { ok: false, reason: 'no Shopify order behind this reprint' };

  const name = shopifyNameFromLabel(label);
  if (!name) return { ok: false, reason: `unexpected Printify label "${label}"` };

  // Printify's store sync writes the numeric Shopify order id. A desk rebuild
  // ("37037-R<time>") or a combined order ("#30307-combined-<date>") only
  // carries the name, so look those up by name.
  const soid = String(linked.metadata?.shop_order_id || '');
  const order = /^\d+$/.test(soid)
    ? await deps.getShopifyOrderById(`gid://shopify/Order/${soid}`)
    : await deps.getShopifyOrderByName(name);
  if (!order) return { ok: false, reason: `Shopify order ${name} not found` };
  // Emailing one customer another customer's tracking is the outcome that must
  // never happen, so the order found has to BE the one Printify named.
  if (order.name !== name) {
    return { ok: false, reason: `Shopify answered ${order.name} when asked for ${name}` };
  }

  return { ok: true, parentId, shopifyOrderId: order.id, shopifyOrderName: order.name };
}
