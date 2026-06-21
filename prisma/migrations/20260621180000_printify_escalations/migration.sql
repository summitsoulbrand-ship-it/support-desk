-- CreateEnum
CREATE TYPE "EscalationResolution" AS ENUM ('REPLACEMENT', 'REFUND');

-- CreateEnum
CREATE TYPE "EscalationStatus" AS ENUM ('PENDING', 'DONE');

-- CreateTable
CREATE TABLE "printify_escalations" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT,
    "order_number" TEXT NOT NULL,
    "shopify_order_id" TEXT,
    "printify_order_id" TEXT,
    "customer_name" TEXT,
    "customer_email" TEXT,
    "resolution" "EscalationResolution" NOT NULL,
    "issue" TEXT NOT NULL,
    "photo_urls" TEXT[],
    "status" "EscalationStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,
    CONSTRAINT "printify_escalations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "printify_escalations_status_idx" ON "printify_escalations"("status");

-- CreateIndex
CREATE INDEX "printify_escalations_thread_id_idx" ON "printify_escalations"("thread_id");
