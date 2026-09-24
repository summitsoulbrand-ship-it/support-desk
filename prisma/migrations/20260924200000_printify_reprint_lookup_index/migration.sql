-- A reprint made in Printify names the order it reprints in
-- data.metadata.reprinted_order_ids, and has no Shopify order of its own. The
-- sidebar and the AI draft find a customer's reprints from the original's side
-- on every thread they open, so without this index that lookup is a
-- sequential scan of every cached order (~0.3 s on 28k rows, 2026-09-24). The
-- query in lib/printify/reprint-lookup.ts uses this exact expression.
CREATE INDEX IF NOT EXISTS "printify_orders_reprinted_order_ids_idx"
  ON "printify_orders" USING gin (("data" -> 'metadata' -> 'reprinted_order_ids'));
