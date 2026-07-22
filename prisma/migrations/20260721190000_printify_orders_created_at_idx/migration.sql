-- Speeds up the `ORDER BY created_at DESC LIMIT 300` cache scans (order search,
-- escalation replacement pool) so they use the index instead of sorting the
-- whole printify_orders table. Part of the 2026-07-21 cache-bloat slowdown fix.
CREATE INDEX IF NOT EXISTS "printify_orders_created_at_idx" ON "printify_orders"("created_at");
