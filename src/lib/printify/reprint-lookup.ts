/**
 * Which of a customer's Shopify orders already have a replacement printed in
 * Printify (a reprint)?
 *
 * A reprint has no Shopify order and no label, so nothing that reads orders
 * by name finds it. It is found from the original's side instead: the cached
 * Printify copies of each Shopify order, joined to every cached order whose
 * metadata.reprinted_order_ids names one of them. The original's own
 * child_reprinted_order_ids would be the shortcut, but its cached copy is
 * usually older than the reprint - it listed the reprint for only 33 of 82
 * reprints on 2026-09-24. The join probes printify_orders_reprinted_order_ids_idx;
 * without that index the lookup scanned the whole cache (~0.3 s per thread).
 * One round trip for a customer with no reprints, which is nearly all of them.
 */

import prisma from '@/lib/db';
import { sameRecipient, summarizeReprint, type ReprintSummary } from './reprint';
import type { PrintifyOrder } from './types';

export type { ReprintSummary };

interface ShopifyOrderRef {
  id: string;
  name: string;
  orderNumber?: number | string | null;
}

interface Row {
  id: string;
  status: string | null;
  data: unknown;
  parentId: string;
  parentData: unknown;
  keys: (string | null)[];
}

/** Reprints of these Shopify orders, keyed by Shopify order id. Cancelled
 *  reprints and ones sent to someone else are left out. */
export async function findPrintifyReprints(
  orders: ShopifyOrderRef[]
): Promise<Record<string, ReprintSummary[]>> {
  const out: Record<string, ReprintSummary[]> = {};
  if (orders.length === 0) return out;

  // The same keys every other lookup uses, plus the combiner's label: a box
  // shipped as "#30307 (combined)" is filed under its earliest order.
  const keyToOrder = new Map<string, ShopifyOrderRef>();
  for (const o of orders) {
    const keys = [
      o.name,
      o.name?.replace('#', ''),
      o.orderNumber != null ? String(o.orderNumber) : null,
      o.id?.replace('gid://shopify/Order/', ''),
      o.name ? `${o.name} (combined)` : null,
    ];
    for (const k of keys) if (k) keyToOrder.set(k, o);
  }
  const keys = [...keyToOrder.keys()];

  const rows = await prisma.$queryRaw<Row[]>`
    SELECT r."id", r."status", r."data",
           p."id" AS "parentId", p."data" AS "parentData",
           ARRAY[p."metadata_shop_order_label", p."metadata_shop_order_id", p."label", p."external_id"] AS "keys"
    FROM "printify_orders" p
    JOIN "printify_orders" r
      ON (r."data" -> 'metadata' -> 'reprinted_order_ids') ? p."id"
    WHERE p."external_id" = ANY(${keys}::text[])
       OR p."label" = ANY(${keys}::text[])
       OR p."metadata_shop_order_id" = ANY(${keys}::text[])
       OR p."metadata_shop_order_label" = ANY(${keys}::text[])
    LIMIT 100
  `;
  if (rows.length === 0) return out;

  // Printify id -> the Shopify order it replaces, for the next hop.
  const owner = new Map<string, ShopifyOrderRef>();
  const add = (row: Row, order: ShopifyOrderRef | undefined) => {
    if (!order || owner.has(row.id)) return;
    const reprint = row.data as PrintifyOrder;
    const parent = row.parentData as PrintifyOrder;
    if (/^cancell?ed$/i.test(String(row.status || reprint.status || ''))) return;
    if (!sameRecipient(reprint.address_to, parent?.address_to)) return;
    owner.set(row.id, order);
    (out[order.id] ||= []).push(summarizeReprint(reprint, order.name));
  };
  for (const row of rows) {
    add(row, row.keys.map((k) => (k ? keyToOrder.get(k) : undefined)).find(Boolean));
  }

  // A reprint of a reprint points at the first reprint, not at the order.
  const firstHop = [...owner.keys()];
  if (firstHop.length > 0) {
    const more = await prisma.$queryRaw<Row[]>`
      SELECT r."id", r."status", r."data", p."id" AS "parentId", p."data" AS "parentData",
             ARRAY[]::text[] AS "keys"
      FROM "printify_orders" p
      JOIN "printify_orders" r
        ON (r."data" -> 'metadata' -> 'reprinted_order_ids') ? p."id"
      WHERE p."id" = ANY(${firstHop}::text[])
      LIMIT 100
    `;
    for (const row of more) add(row, owner.get(row.parentId));
  }

  for (const list of Object.values(out)) {
    list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }
  return out;
}
