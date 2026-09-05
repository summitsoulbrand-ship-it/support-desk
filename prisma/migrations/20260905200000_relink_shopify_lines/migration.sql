-- What Shopify line set a rebuilt Printify order was built from, as {sku: qty}.
-- Printify stamps its OWN product ids and SKUs on API-created orders, so such an
-- order can never be compared to Shopify by SKU again. Recording what we sent is
-- what lets the next comparison run against our own record instead.
ALTER TABLE "order_relinks" ADD COLUMN IF NOT EXISTS "shopify_lines" JSONB;
