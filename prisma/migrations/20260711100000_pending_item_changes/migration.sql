-- Customer-requested size/color swaps that cost more, parked until the
-- customer pays the Shopify balance. Applied or reverted by the worker's
-- payment watcher.
CREATE TYPE "PendingItemChangeStatus" AS ENUM (
  'AWAITING_PAYMENT',
  'APPLIED',
  'EXPIRED_REVERTED',
  'CANCELLED',
  'FAILED'
);

CREATE TABLE "pending_item_changes" (
  "id" TEXT NOT NULL,
  "shopify_order_id" TEXT NOT NULL,
  "shopify_order_name" TEXT NOT NULL,
  "customer_email" TEXT NOT NULL,
  "printify_order_id" TEXT NOT NULL,
  "line_item_id" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "item_title" TEXT NOT NULL,
  "old_variant_id" TEXT NOT NULL,
  "old_variant_title" TEXT NOT NULL,
  "old_unit_full" TEXT NOT NULL,
  "removed_paid" TEXT NOT NULL,
  "new_variant_id" TEXT NOT NULL,
  "new_variant_title" TEXT NOT NULL,
  "charge_amount" TEXT NOT NULL,
  "status" "PendingItemChangeStatus" NOT NULL DEFAULT 'AWAITING_PAYMENT',
  "pay_by" TIMESTAMP(3) NOT NULL,
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "pending_item_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pending_item_changes_status_pay_by_idx" ON "pending_item_changes"("status", "pay_by");
CREATE INDEX "pending_item_changes_shopify_order_id_idx" ON "pending_item_changes"("shopify_order_id");
