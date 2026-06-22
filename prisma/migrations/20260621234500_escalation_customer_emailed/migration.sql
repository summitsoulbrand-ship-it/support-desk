-- Track when the operator emailed the customer a delay update (set when they
-- click the "Email about delay" button; mailto can't report back).
ALTER TABLE "printify_escalations"
  ADD COLUMN "customer_emailed_at" TIMESTAMP(3),
  ADD COLUMN "customer_emailed_by" TEXT;
