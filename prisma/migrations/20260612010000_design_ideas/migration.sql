CREATE TABLE "design_ideas" (
  "id" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "author_name" TEXT,
  "permalink" TEXT,
  "source_id" TEXT,
  "note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "design_ideas_pkey" PRIMARY KEY ("id")
);
