-- Late-order resolution: track customer refund + Printify refund separately,
-- with notes purely informational. Resolution is derived from these fields.
ALTER TABLE "late_order_resolutions" ADD COLUMN IF NOT EXISTS "customer_refunded" boolean;
ALTER TABLE "late_order_resolutions" ADD COLUMN IF NOT EXISTS "refunded_by_printify" boolean;

-- Migrate the existing legacy solved row(s) so they stay resolved under the new
-- rule (resolved = customer made whole AND Printify decision recorded).
UPDATE "late_order_resolutions"
  SET "refunded_by_printify" = true, "customer_refunded" = true
  WHERE "solved" = true AND "refunded_by_printify" IS NULL;
