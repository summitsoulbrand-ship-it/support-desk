-- Two things the daily report could not say before.
--
-- `detail` carries what exactly went wrong, in the customer's own words: which
-- shirt color, which part of the print, when it appeared. Measured need - over
-- 30 days, 6 of 7 print complaints reached Pati as nothing but "+1" in a count
-- column, including "text blends into blue shirt, not readable", which is a
-- design decision she can act on and never saw.
--
-- `blocked_purchase` separates a checkout or discount message that STOPPED
-- someone buying from one that merely asks about a code. Of 32 discount-code
-- rows in the same window, roughly a third were real failures and the rest
-- were questions; without this flag the two are indistinguishable.

ALTER TABLE "customer_issues"
  ADD COLUMN IF NOT EXISTS "detail"           TEXT,
  ADD COLUMN IF NOT EXISTS "blocked_purchase" BOOLEAN;
