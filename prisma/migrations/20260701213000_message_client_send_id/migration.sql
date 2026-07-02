-- Idempotency key for outbound sends (retry-safe against deploy-window
-- proxy errors and connection timeouts)
ALTER TABLE "messages" ADD COLUMN "client_send_id" TEXT;
CREATE UNIQUE INDEX "messages_client_send_id_key" ON "messages"("client_send_id");
