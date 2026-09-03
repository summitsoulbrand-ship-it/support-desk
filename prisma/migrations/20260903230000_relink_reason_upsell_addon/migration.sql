-- An upsell that arrived too late to merge ships as its OWN second box.
-- Distinct from UPSELL so tracking is never pushed for it: the add-on shares a
-- Shopify order with the main box, and pushing would overwrite the main box's
-- tracking number.
ALTER TYPE "RelinkReason" ADD VALUE IF NOT EXISTS 'UPSELL_ADDON';
