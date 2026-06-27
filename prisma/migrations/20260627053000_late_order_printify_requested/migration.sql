-- Track orders we asked Printify to refund/reprint/cancel (from the support
-- inbox) that have no confirmation back yet -> "Awaiting Printify" in the UI.
ALTER TABLE "late_order_resolutions"
  ADD COLUMN "printify_requested_at" TIMESTAMP(3),
  ADD COLUMN "printify_request_intent" TEXT;
