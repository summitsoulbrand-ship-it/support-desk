-- CreateTable
CREATE TABLE "printify_orders" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT,
    "external_id" TEXT,
    "label" TEXT,
    "metadata_shop_order_id" TEXT,
    "metadata_shop_order_label" TEXT,
    "status" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "printify_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "printify_orders_external_id_idx" ON "printify_orders"("external_id");

-- CreateIndex
CREATE INDEX "printify_orders_label_idx" ON "printify_orders"("label");

-- CreateIndex
CREATE INDEX "printify_orders_metadata_shop_order_id_idx" ON "printify_orders"("metadata_shop_order_id");

-- CreateIndex
CREATE INDEX "printify_orders_metadata_shop_order_label_idx" ON "printify_orders"("metadata_shop_order_label");

-- CreateIndex
CREATE INDEX "printify_orders_updated_at_idx" ON "printify_orders"("updated_at");
