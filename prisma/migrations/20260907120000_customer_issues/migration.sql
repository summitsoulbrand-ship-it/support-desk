-- Customer issue reporting: the daily digest of what customers complained
-- about, and the alarm that fires when several of them report the same thing.

CREATE TYPE "IssueCategory" AS ENUM (
  'PRINT_QUALITY',
  'GARMENT_QUALITY',
  'SIZING_FIT',
  'WRONG_ITEM',
  'SHIPPING_DELAY',
  'NOT_DELIVERED',
  'ADDRESS_CHANGE',
  'CANCELLATION',
  'REFUND_RETURN',
  'DISCOUNT_CODE',
  'WEBSITE_CHECKOUT',
  'PRODUCT_QUESTION',
  'PRAISE',
  'OTHER'
);

CREATE TYPE "IssueSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

CREATE TYPE "IssueAlertKind" AS ENUM ('DAILY_REPORT', 'PATTERN');

CREATE TABLE "customer_issues" (
  "id"             TEXT NOT NULL,
  "thread_id"      TEXT NOT NULL,
  "message_id"     TEXT NOT NULL,
  "customer_email" TEXT NOT NULL,
  "customer_name"  TEXT,
  "category"       "IssueCategory" NOT NULL,
  "severity"       "IssueSeverity" NOT NULL DEFAULT 'LOW',
  "design_name"    TEXT,
  "design_source"  TEXT,
  "problem"        TEXT,
  "summary"        TEXT NOT NULL,
  "occurred_at"    TIMESTAMP(3) NOT NULL,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "customer_issues_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_issues_message_id_key" ON "customer_issues"("message_id");
CREATE INDEX "customer_issues_occurred_at_idx" ON "customer_issues"("occurred_at");
CREATE INDEX "customer_issues_category_occurred_at_idx" ON "customer_issues"("category", "occurred_at");
CREATE INDEX "customer_issues_design_name_occurred_at_idx" ON "customer_issues"("design_name", "occurred_at");

ALTER TABLE "customer_issues"
  ADD CONSTRAINT "customer_issues_thread_id_fkey"
  FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "issue_alerts" (
  "id"             TEXT NOT NULL,
  "key"            TEXT NOT NULL,
  "kind"           "IssueAlertKind" NOT NULL,
  "label"          TEXT NOT NULL,
  "customer_count" INTEGER NOT NULL DEFAULT 0,
  "first_sent_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_sent_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "issue_alerts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "issue_alerts_key_key" ON "issue_alerts"("key");
CREATE INDEX "issue_alerts_kind_last_sent_at_idx" ON "issue_alerts"("kind", "last_sent_at");

-- Which design a complaint is about is looked up from the local Printify order
-- cache by the buyer's email, rather than by calling Shopify per thread. That
-- lookup reads inside the JSON blob, so without this expression index it is a
-- sequential scan of every cached order.
CREATE INDEX IF NOT EXISTS "printify_orders_address_email_idx"
  ON "printify_orders" ((lower("data" -> 'address_to' ->> 'email')));
