-- Add composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS "threads_status_assigned_user_id_idx" ON "threads"("status", "assigned_user_id");
CREATE INDEX IF NOT EXISTS "threads_customer_email_status_idx" ON "threads"("customer_email", "status");
CREATE INDEX IF NOT EXISTS "threads_status_last_message_at_idx" ON "threads"("status", "last_message_at");
