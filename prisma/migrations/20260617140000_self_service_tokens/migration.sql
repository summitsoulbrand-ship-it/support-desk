-- Single-use, hashed, expiring tokens for the customer self-service portal
CREATE TABLE IF NOT EXISTS "self_service_tokens" (
  "id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "shopify_order_id" TEXT NOT NULL,
  "shopify_order_name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "printify_order_id" TEXT,
  "request_ip" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "self_service_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "self_service_tokens_token_hash_key" ON "self_service_tokens"("token_hash");
CREATE INDEX IF NOT EXISTS "self_service_tokens_expires_at_idx" ON "self_service_tokens"("expires_at");
