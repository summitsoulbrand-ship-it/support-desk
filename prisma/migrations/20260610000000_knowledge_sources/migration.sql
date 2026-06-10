-- CreateEnum
CREATE TYPE "KnowledgeType" AS ENUM ('BRAND', 'AVATAR', 'SHOPIFY_PAGE', 'SHOPIFY_POLICY', 'CUSTOM');

-- CreateTable
CREATE TABLE "knowledge_sources" (
    "id" TEXT NOT NULL,
    "type" "KnowledgeType" NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_sources_key_key" ON "knowledge_sources"("key");

-- CreateIndex
CREATE INDEX "knowledge_sources_type_idx" ON "knowledge_sources"("type");
