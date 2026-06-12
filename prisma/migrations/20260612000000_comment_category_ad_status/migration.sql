-- Comment categorization for inbox priority + ad delivery status
ALTER TABLE "social_comments" ADD COLUMN "category" TEXT;
ALTER TABLE "social_comments" ADD COLUMN "category_rank" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "social_objects" ADD COLUMN "ad_status" TEXT;

CREATE INDEX "social_comments_status_category_rank_idx" ON "social_comments"("status", "category_rank");
