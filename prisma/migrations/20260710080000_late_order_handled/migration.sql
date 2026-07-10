-- Operator can explicitly mark a late order done/handled (only once both the
-- customer-refunded and refunded-by-Printify questions are answered).
ALTER TABLE "late_order_resolutions"
  ADD COLUMN "handled_at" TIMESTAMP(3),
  ADD COLUMN "handled_by" TEXT;
