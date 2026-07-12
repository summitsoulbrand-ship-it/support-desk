-- Printify support's latest per-order answer line (mined from their emails).
-- Shown on the Late Deliveries row and prefilled into the customer delay email.
ALTER TABLE "late_order_resolutions"
  ADD COLUMN "printify_answer" TEXT,
  ADD COLUMN "printify_answer_at" TIMESTAMP(3);
