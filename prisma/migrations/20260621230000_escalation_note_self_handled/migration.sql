-- Operator note + "we handled it ourselves" state (when Printify declined to
-- refund/replace, so Summit Soul issued the refund/replacement instead).
ALTER TABLE "printify_escalations"
  ADD COLUMN "self_handled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "self_handled_at" TIMESTAMP(3),
  ADD COLUMN "self_handled_by" TEXT,
  ADD COLUMN "note" TEXT;
