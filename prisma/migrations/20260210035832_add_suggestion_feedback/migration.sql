-- CreateTable
CREATE TABLE "suggestion_feedback" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "original_draft" TEXT NOT NULL,
    "edited_draft" TEXT NOT NULL,
    "category" TEXT,
    "thread_tags" TEXT[],
    "user_id" TEXT NOT NULL,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suggestion_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suggestion_feedback_category_idx" ON "suggestion_feedback"("category");

-- CreateIndex
CREATE INDEX "suggestion_feedback_created_at_idx" ON "suggestion_feedback"("created_at");
