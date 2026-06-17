-- Operator-applied resolution for late orders
CREATE TABLE IF NOT EXISTS "late_order_resolutions" (
  "id" TEXT NOT NULL,
  "printify_order_id" TEXT NOT NULL,
  "solved" BOOLEAN NOT NULL DEFAULT true,
  "note" TEXT,
  "resolved_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "late_order_resolutions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "late_order_resolutions_printify_order_id_key" ON "late_order_resolutions"("printify_order_id");
