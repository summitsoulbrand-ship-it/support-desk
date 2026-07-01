-- Chunked backup storage: large dumps split across rows sharing a filename.
-- Existing single-row backups become part 0 of 1 via the defaults.
ALTER TABLE "database_backups" ADD COLUMN "part" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "database_backups" ADD COLUMN "part_count" INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX "database_backups_filename_part_key" ON "database_backups"("filename", "part");
