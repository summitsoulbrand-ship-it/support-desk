-- Pre-generated AI reply drafts for social comments
ALTER TABLE "social_comments" ADD COLUMN "ai_draft" TEXT;
ALTER TABLE "social_comments" ADD COLUMN "ai_draft_at" TIMESTAMP(3);
