-- Track when the operator emailed the customer a delay update from the late
-- deliveries tab (sent via the tool; the mailto/compose can't report back).
ALTER TABLE "late_order_resolutions"
  ADD COLUMN "delay_emailed_at" TIMESTAMP(3),
  ADD COLUMN "delay_emailed_by" TEXT;
