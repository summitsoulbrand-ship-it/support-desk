-- Post-purchase upsell merges reuse the relink machinery (cancel + recreate
-- the Printify order), so they need their own reason for reporting.
ALTER TYPE "RelinkReason" ADD VALUE IF NOT EXISTS 'UPSELL';
