-- Real RFC-5322 Message-ID for outbound emails.
-- The Zoho Mail API returns only its own numeric id when it sends, so the id a
-- customer's mail client quotes back in In-Reply-To was never stored anywhere.
-- Replies that referenced only our last email therefore matched no existing
-- message and opened a duplicate thread.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "rfc_message_id" TEXT;

CREATE INDEX IF NOT EXISTS "messages_rfc_message_id_idx" ON "messages"("rfc_message_id");
