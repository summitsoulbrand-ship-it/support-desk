/**
 * Printify reprint/refund claim window. Printify only accepts a defect/lost
 * claim within ~30 days of DELIVERY, and there is no claims API (claims are
 * filed by hand in the dashboard), so an escalation that sits un-filed past the
 * window means we eat the reship cost. This computes how long is left so the
 * Needs Attention queue can flag claims before they expire.
 */

export const PRINTIFY_CLAIM_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ClaimWindowStatus = 'overdue' | 'soon' | 'ok' | 'unknown';

export interface ClaimWindow {
  /** ISO date the 30-day window closes, or null when no delivery date is known. */
  deadline: string | null;
  /** Whole days remaining (negative once overdue), or null when unknown. */
  daysLeft: number | null;
  status: ClaimWindowStatus;
}

/**
 * @param deliveredAt carrier/Printify delivery timestamp (ISO), if known
 * @param now        injected for testability
 * @param soonDays   how many days out counts as "file it now" (default 5)
 */
export function claimWindowFromDelivery(
  deliveredAt: string | null | undefined,
  now: Date,
  soonDays = 5
): ClaimWindow {
  if (!deliveredAt) return { deadline: null, daysLeft: null, status: 'unknown' };
  const delivered = new Date(deliveredAt);
  if (Number.isNaN(delivered.getTime())) {
    return { deadline: null, daysLeft: null, status: 'unknown' };
  }
  const deadline = new Date(delivered.getTime() + PRINTIFY_CLAIM_WINDOW_DAYS * DAY_MS);
  const daysLeft = Math.ceil((deadline.getTime() - now.getTime()) / DAY_MS);
  const status: ClaimWindowStatus =
    daysLeft < 0 ? 'overdue' : daysLeft <= soonDays ? 'soon' : 'ok';
  return { deadline: deadline.toISOString(), daysLeft, status };
}

/**
 * Latest delivery timestamp across a Printify order's shipments (the claim
 * clock starts at the most recent delivery), or null if none delivered yet.
 */
export function latestDeliveredAt(
  shipments?: { delivered_at?: string | null }[] | null
): string | null {
  if (!shipments?.length) return null;
  const times = shipments
    .map((s) => s.delivered_at)
    .filter((d): d is string => !!d)
    .map((d) => new Date(d).getTime())
    .filter((t) => !Number.isNaN(t));
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}
