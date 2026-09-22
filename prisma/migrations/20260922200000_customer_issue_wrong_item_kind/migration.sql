-- What was wrong with a wrong parcel.
--
-- A wrong color, a wrong design, a wrong size, a missing shirt and an extra
-- item all landed as WRONG_ITEM under whichever design was ordered, so one
-- Printify packing problem read as several separate design problems. Measured
-- 2026-09-22: six wrong-item complaints in a day against 1.4 normally, spread
-- over five designs; two checked against their Shopify orders had the right
-- order and the wrong parcel. The report now groups these by what went wrong,
-- across every design. Null on rows written before this existed - those are
-- read from the words instead.

ALTER TABLE "customer_issues"
  ADD COLUMN IF NOT EXISTS "wrong_item_kind" TEXT;
