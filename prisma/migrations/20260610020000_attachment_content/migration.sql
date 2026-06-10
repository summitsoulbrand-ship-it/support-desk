-- Store attachment bytes in the DB (cross-service + survives redeploys)
ALTER TABLE "attachments" ADD COLUMN "content" BYTEA;
