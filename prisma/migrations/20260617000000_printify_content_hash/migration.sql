-- Add a content hash to the Printify order cache so the incremental sync can
-- skip re-writing unchanged orders within its window (the Printify order-list
-- payload has no updated_at to diff against). Nullable: existing rows backfill
-- the next time the sync touches them.
ALTER TABLE "printify_orders" ADD COLUMN "content_hash" TEXT;
