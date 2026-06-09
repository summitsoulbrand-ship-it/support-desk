-- CreateEnum
CREATE TYPE "TriageIntent" AS ENUM ('SIZE_EXCHANGE', 'SHIPPING_STATUS', 'ADDRESS_UPDATE', 'CANCELLATION', 'OTHER');

-- CreateEnum
CREATE TYPE "AiDraftStatus" AS ENUM ('PENDING', 'READY', 'FAILED', 'STALE');

-- CreateEnum
CREATE TYPE "RelinkReason" AS ENUM ('ADDRESS_CHANGE', 'REPLACEMENT', 'REROUTE');

-- CreateEnum
CREATE TYPE "RelinkStatus" AS ENUM ('PENDING', 'IN_PRODUCTION', 'FULFILLED_PUSHED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "thread_triage" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "intent" "TriageIntent" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "entities" JSONB,
    "classified_message_id" TEXT,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "thread_triage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_drafts" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "for_message_id" TEXT,
    "body" TEXT NOT NULL,
    "status" "AiDraftStatus" NOT NULL DEFAULT 'PENDING',
    "warnings" JSONB,
    "intent" "TriageIntent",
    "model" TEXT,
    "context_refreshed_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_relinks" (
    "id" TEXT NOT NULL,
    "printify_order_id" TEXT NOT NULL,
    "original_printify_order_id" TEXT,
    "shopify_order_id" TEXT NOT NULL,
    "shopify_order_name" TEXT,
    "reason" "RelinkReason" NOT NULL,
    "status" "RelinkStatus" NOT NULL DEFAULT 'PENDING',
    "tracking_number" TEXT,
    "carrier" TEXT,
    "fulfillment_pushed_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_relinks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "thread_triage_thread_id_key" ON "thread_triage"("thread_id");

-- CreateIndex
CREATE INDEX "thread_triage_intent_idx" ON "thread_triage"("intent");

-- CreateIndex
CREATE UNIQUE INDEX "ai_drafts_thread_id_key" ON "ai_drafts"("thread_id");

-- CreateIndex
CREATE INDEX "ai_drafts_status_idx" ON "ai_drafts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "order_relinks_printify_order_id_key" ON "order_relinks"("printify_order_id");

-- CreateIndex
CREATE INDEX "order_relinks_status_idx" ON "order_relinks"("status");

-- CreateIndex
CREATE INDEX "order_relinks_shopify_order_id_idx" ON "order_relinks"("shopify_order_id");

-- AddForeignKey
ALTER TABLE "thread_triage" ADD CONSTRAINT "thread_triage_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
