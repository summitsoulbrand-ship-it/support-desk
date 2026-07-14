-- Multi-item self-service changes: a single parked payment can now hold an
-- ARRAY of line changes (change all items at once, settled as one net
-- difference). `changes` is the JSON array; legacy single-item rows keep it
-- null and use the flat old*/new* columns.
ALTER TABLE "pending_item_changes"
  ADD COLUMN "changes" JSONB;
