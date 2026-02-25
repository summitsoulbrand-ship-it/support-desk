-- CreateEnum
CREATE TYPE "FilterRuleCondition" AS ENUM ('SUBJECT_CONTAINS', 'SUBJECT_STARTS_WITH', 'EMAIL_CONTAINS', 'EMAIL_DOMAIN');

-- CreateTable
CREATE TABLE "filter_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "condition" "FilterRuleCondition" NOT NULL,
    "value" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "filter_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "filter_rules_enabled_idx" ON "filter_rules"("enabled");
