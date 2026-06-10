-- CreateEnum
CREATE TYPE "ReviewDraftStatus" AS ENUM ('PENDING', 'READY', 'FAILED', 'HANDLED');

-- CreateTable
CREATE TABLE "review_drafts" (
    "id" TEXT NOT NULL,
    "review_id" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "reviewer_name" TEXT,
    "review_title" TEXT,
    "review_body" TEXT,
    "product_title" TEXT,
    "review_created_at" TIMESTAMP(3),
    "body" TEXT NOT NULL,
    "status" "ReviewDraftStatus" NOT NULL DEFAULT 'PENDING',
    "model" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "review_drafts_review_id_key" ON "review_drafts"("review_id");

-- CreateIndex
CREATE INDEX "review_drafts_status_idx" ON "review_drafts"("status");
