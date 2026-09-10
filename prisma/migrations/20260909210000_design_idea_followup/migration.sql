-- Design ideas grow a follow-up pipeline: did we make the design the customer
-- asked for, and have we told them about it yet.

ALTER TABLE "design_ideas"
  ADD COLUMN IF NOT EXISTS "status"         TEXT NOT NULL DEFAULT 'OPEN',
  ADD COLUMN IF NOT EXISTS "customer_email" TEXT,
  ADD COLUMN IF NOT EXISTS "product_handle" TEXT,
  ADD COLUMN IF NOT EXISTS "product_title"  TEXT,
  ADD COLUMN IF NOT EXISTS "product_image"  TEXT,
  ADD COLUMN IF NOT EXISTS "made_at"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "notified_at"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "notified_via"   TEXT,
  ADD COLUMN IF NOT EXISTS "thread_id"      TEXT;

CREATE INDEX IF NOT EXISTS "design_ideas_status_idx" ON "design_ideas"("status");
