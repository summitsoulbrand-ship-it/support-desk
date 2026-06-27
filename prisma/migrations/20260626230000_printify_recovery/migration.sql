-- Money recovered from Printify, auto-detected from merchantsupport@printify.com
-- support emails. One row per confirmed outcome (refund / partial refund /
-- reprint / cancellation) on one order. Drives the Late Deliveries "Refunded by
-- Printify" tick and a recovered-total report.
CREATE TABLE "printify_recoveries" (
    "id" TEXT NOT NULL,
    "app_order_id" TEXT NOT NULL,
    "printify_order_id" TEXT,
    "type" TEXT NOT NULL,
    "amount_usd" DOUBLE PRECISION,
    "reprint_app_order_id" TEXT,
    "email_message_id" TEXT NOT NULL,
    "email_date" TIMESTAMP(3) NOT NULL,
    "ticket_url" TEXT,
    "evidence" TEXT NOT NULL,
    "matched" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "printify_recoveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "printify_recoveries_email_message_id_app_order_id_type_key"
    ON "printify_recoveries"("email_message_id", "app_order_id", "type");

CREATE INDEX "printify_recoveries_app_order_id_idx"
    ON "printify_recoveries"("app_order_id");

CREATE INDEX "printify_recoveries_email_date_idx"
    ON "printify_recoveries"("email_date");
