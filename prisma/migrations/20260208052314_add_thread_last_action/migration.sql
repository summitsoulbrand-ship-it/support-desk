-- AlterTable
ALTER TABLE "threads" ADD COLUMN     "last_action_at" TIMESTAMP(3),
ADD COLUMN     "last_action_data" JSONB,
ADD COLUMN     "last_action_type" TEXT;
