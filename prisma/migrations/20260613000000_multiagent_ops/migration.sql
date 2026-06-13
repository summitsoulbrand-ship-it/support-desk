-- Thread manual-escalation flag
ALTER TABLE "threads" ADD COLUMN "needs_manual" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "threads" ADD COLUMN "manual_reason" TEXT;
ALTER TABLE "threads" ADD COLUMN "manual_resolved_at" TIMESTAMP(3);

-- Per-agent send attribution
ALTER TABLE "messages" ADD COLUMN "sent_by_user_id" TEXT;

-- Refund approval threshold
ALTER TABLE "app_settings" ADD COLUMN "refund_approval_threshold_cents" INTEGER NOT NULL DEFAULT 0;

-- Append-only action audit log
CREATE TABLE "action_logs" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT,
    "user_id" TEXT,
    "user_name" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "amount_cents" INTEGER,
    "order_name" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "action_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "action_logs_created_at_idx" ON "action_logs"("created_at");
CREATE INDEX "action_logs_thread_id_idx" ON "action_logs"("thread_id");

-- Canned replies / macros
CREATE TABLE "canned_replies" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "body" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "canned_replies_pkey" PRIMARY KEY ("id")
);

-- Needs-attention query helper
CREATE INDEX "threads_needs_manual_idx" ON "threads"("needs_manual");
