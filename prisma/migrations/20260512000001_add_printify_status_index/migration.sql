-- Add composite index for Printify order status queries
CREATE INDEX IF NOT EXISTS "printify_orders_status_created_at_idx" ON "printify_orders"("status", "created_at");
