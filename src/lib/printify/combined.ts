/**
 * Combined shipments - orders the nightly order combiner folded together.
 *
 * When one customer places two orders the same day to the same address, the
 * combiner (automation/order_combiner, ~05:00 UTC) cancels BOTH orders' Printify
 * copies and creates ONE combined Printify order holding every shirt. That
 * order is filed under the EARLIEST order's name as "#12345 (combined)", so
 * every lookup in this codebase that matches a Printify order by the Shopify
 * order's own name or id finds only the cancelled originals.
 *
 * Left alone, the desk therefore tells an agent "Printify: cancelled" about an
 * order whose shirts are printing, and its Cancel button refunds the customer
 * while the combined order ships everything anyway. (Found 2026-09-19 by
 * reading the code; it had not happened yet - agents made one cancel in the
 * previous 30 days.)
 *
 * The only reliable link is the set of Shopify tags the combiner writes:
 *   earliest order ("survivor"):  combined-primary, combined-po-<printify id>
 *   every other order:            combined-shipment, combined-into-#<survivor>
 *
 * A combined order belongs to SEVERAL Shopify orders, so nothing here ever
 * cancels or rebuilds one automatically - doing that for one order would take
 * the other order's shirts down with it. The desk shows it and hands the
 * Printify side to a human.
 */

import prisma from '@/lib/db';
import { createPrintifyClient, PrintifyClient } from '@/lib/printify';
import type { PrintifyOrder } from '@/lib/printify/types';
import { createShopifyClient } from '@/lib/shopify';

const isCancelledStatus = (s?: string | null) => !!s && /^cancell?ed$/i.test(s.trim());

export interface CombinedTags {
  /** The order the combined Printify order is filed under, e.g. "#38526". */
  survivorName: string | null;
  /** From the survivor's own `combined-po-<id>` tag; null on the other orders. */
  printifyOrderId: string | null;
  isSurvivor: boolean;
}

/**
 * Read the combiner's tags off a Shopify order. Null when the order was never
 * combined. Pure - no I/O - so every rule here is pinned by a test.
 *
 * "Any tag starting with `combined`" is the same test the upsell merge uses to
 * step aside, so the two can never disagree about whose order this is.
 */
export function parseCombinedTags(order: {
  name?: string | null;
  tags?: string[] | null;
}): CombinedTags | null {
  const tags = (order.tags || []).map((t) => t.trim()).filter(Boolean);
  if (!tags.some((t) => t.toLowerCase().startsWith('combined'))) return null;

  let printifyOrderId: string | null = null;
  let into: string | null = null;
  let primary = false;
  for (const t of tags) {
    const po = t.match(/^combined-po-([0-9a-f]{24})$/i);
    if (po) printifyOrderId = po[1].toLowerCase();
    const m = t.match(/^combined-into-(#?\d+)$/i);
    if (m) into = m[1].startsWith('#') ? m[1] : `#${m[1]}`;
    if (/^combined-primary$/i.test(t)) primary = true;
  }

  const isSurvivor = primary || (!!printifyOrderId && !into);
  return {
    survivorName: into || (isSurvivor ? order.name || null : null),
    printifyOrderId,
    isSurvivor,
  };
}

/** Is this Printify order (as cached) one the combiner built? */
export function isCombinedPrintifyLabel(label?: string | null): boolean {
  return !!label && /\(combined\)\s*$/i.test(label);
}

export type CombinedState = 'on-hold' | 'in-production' | 'cancelled' | 'unknown';

export interface CombinedShipment {
  survivorName: string | null;
  printifyOrderId: string | null;
  /** The combined Printify order; null when it could not be found or read. */
  order: PrintifyOrder | null;
  /**
   * 'unknown' means we could not find or read it - callers must treat that as
   * "may well be printing", never as "nothing there".
   */
  state: CombinedState;
}

export function combinedStateOf(order: PrintifyOrder | null): CombinedState {
  if (!order) return 'unknown';
  if (isCancelledStatus(order.status)) return 'cancelled';
  return PrintifyClient.canCancelOrder(order) ? 'on-hold' : 'in-production';
}

/**
 * Find the combined Printify order for a Shopify order the combiner has tagged.
 * Returns null when the order was never combined.
 *
 *  - source 'live' (default): re-read the order from Printify. REQUIRED before
 *    refusing or allowing any action.
 *  - source 'cache': trust the webhook-fed cache row. Fine for the sidebar.
 */
export async function resolveCombinedShipment(
  order: { name?: string | null; tags?: string[] | null },
  opts?: { source?: 'live' | 'cache' }
): Promise<CombinedShipment | null> {
  const parsed = parseCombinedTags(order);
  if (!parsed) return null;

  let id = parsed.printifyOrderId;
  let cached: PrintifyOrder | null = null;

  // The cache knows the combined order by its label, which is how an order
  // that is NOT the survivor finds it without a Shopify round trip.
  if (parsed.survivorName) {
    const label = `${parsed.survivorName} (combined)`;
    const rows = await prisma.printifyOrderCache
      .findMany({
        where: {
          OR: [
            { metadataShopOrderLabel: label },
            { label },
            ...(id ? [{ id }] : []),
          ],
        },
        orderBy: { createdAt: 'desc' },
      })
      .catch(() => []);
    // A live one wins; a re-run of the combiner (--recover) can leave a
    // cancelled sibling under the same label.
    const row =
      (id && rows.find((r) => r.id === id)) ||
      rows.find((r) => !isCancelledStatus(r.status)) ||
      rows[0];
    if (row) {
      id = id || row.id;
      const data = row.data as unknown as PrintifyOrder | null;
      cached = data && Array.isArray(data.line_items) ? data : null;
    }
  }

  // Not in the cache yet (the sync loop runs every ten minutes): the survivor's
  // own tag carries the id.
  if (!id && parsed.survivorName && !parsed.isSurvivor) {
    try {
      const shopify = await createShopifyClient();
      const survivor = shopify
        ? await shopify.getOrderByNumber(parsed.survivorName)
        : null;
      id = survivor ? parseCombinedTags(survivor)?.printifyOrderId || null : null;
    } catch {
      id = null;
    }
  }

  if (!id) {
    return { survivorName: parsed.survivorName, printifyOrderId: null, order: null, state: 'unknown' };
  }

  let resolved: PrintifyOrder | null = cached;
  if ((opts?.source ?? 'live') === 'live' || !resolved) {
    try {
      const printify = await createPrintifyClient();
      resolved = printify ? await printify.getOrder(id) : null;
    } catch {
      resolved = null;
    }
  }

  return {
    survivorName: parsed.survivorName,
    printifyOrderId: id,
    order: resolved,
    state: combinedStateOf(resolved),
  };
}

export type CombinedAction = 'cancel' | 'address' | 'item';

/**
 * What the agent is told when an action is refused on a combined order. Plain
 * English, and it always says what to do instead - a refusal that only says
 * "no" just gets worked around in Shopify admin, which is the refund-while-it-
 * prints outcome this exists to prevent.
 */
export function combinedActionMessage(
  orderName: string,
  c: Pick<CombinedShipment, 'survivorName' | 'state'>,
  action: CombinedAction
): string {
  const other =
    c.survivorName && c.survivorName !== orderName
      ? `together with ${c.survivorName}`
      : 'together with another order from the same customer';
  const where = `${orderName} ships inside ONE combined Printify order, ${other}.`;

  if (c.state === 'in-production') {
    const tail =
      action === 'cancel'
        ? 'That combined order is already printing, so the shirts will still ship. Ask Printify to cancel it, or refund anyway knowing it ships.'
        : 'That combined order is already printing, so it can no longer be changed. Use the replacement flow if the customer needs a different item or address.';
    return `${where} ${tail}`;
  }
  if (c.state === 'unknown') {
    return `${where} The desk could not read that combined order, so assume it is printing: open it in Printify and check before you refund or promise a change.`;
  }

  // on-hold: still changeable, but only by hand, because it holds two orders.
  switch (action) {
    case 'cancel':
      return `${where} It has not printed yet. Cancelling from here would refund ${orderName} while its shirts still print. In Printify, open the combined order and remove ${orderName}'s items (or cancel the whole combined order if the customer is cancelling both), THEN come back and refund here.`;
    case 'address':
      return `${where} It has not printed yet. The desk did NOT change the address on Printify: rebuilding the combined order would break tracking for the other order. Edit the address on the combined order in Printify by hand.`;
    case 'item':
      return `${where} It has not printed yet, but the desk cannot rebuild a combined order without breaking the other order's tracking. Change the item on the combined order in Printify by hand, then edit the Shopify order to match.`;
  }
}
