-- Hardening for parked pricier swaps:
--  * pre_edit_line_ids: the order's line-item ids BEFORE the swap edit, so the
--    watcher can always identify the exact ADDED line (revert must never
--    guess by variant+quantity - it could remove a customer's paid sibling
--    line) and can detect a crash where the edit never committed.
--  * partial unique index: at most ONE awaiting-payment change per order,
--    enforced by the database (the route's findFirst check alone is a
--    check-then-act race).
ALTER TABLE "pending_item_changes"
  ADD COLUMN "pre_edit_line_ids" TEXT;

CREATE UNIQUE INDEX "pending_item_changes_one_awaiting_per_order"
  ON "pending_item_changes"("shopify_order_id")
  WHERE "status" = 'AWAITING_PAYMENT';
