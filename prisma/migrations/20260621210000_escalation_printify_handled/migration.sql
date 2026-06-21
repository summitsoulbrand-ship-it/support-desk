-- Printify-side action mark (reprint created / Printify refunded us). Not
-- API-detectable, so the operator ticks it by hand. The customer's Shopify
-- refund stays auto-detected separately.
ALTER TABLE "printify_escalations"
  ADD COLUMN "printify_handled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "printify_handled_at" TIMESTAMP(3),
  ADD COLUMN "printify_handled_by" TEXT;
