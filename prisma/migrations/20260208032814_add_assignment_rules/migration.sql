-- CreateEnum
CREATE TYPE "AssignmentRuleCondition" AS ENUM ('SUBJECT_CONTAINS', 'SUBJECT_STARTS_WITH', 'EMAIL_CONTAINS', 'EMAIL_DOMAIN', 'BODY_CONTAINS');

-- CreateTable
CREATE TABLE "assignment_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "condition" "AssignmentRuleCondition" NOT NULL,
    "value" TEXT NOT NULL,
    "assign_to_id" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignment_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assignment_rules_enabled_idx" ON "assignment_rules"("enabled");

-- CreateIndex
CREATE INDEX "assignment_rules_priority_idx" ON "assignment_rules"("priority");

-- AddForeignKey
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_assign_to_id_fkey" FOREIGN KEY ("assign_to_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
