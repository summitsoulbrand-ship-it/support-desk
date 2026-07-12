/**
 * The production cutoff clock. Printify's nightly sweep sends everything to
 * production around 11pm America/Los_Angeles (verified 2026-07-11 from our
 * own replacement orders: sent_to_production_at ~06:04 UTC = 11:04pm PDT).
 *
 * An order placed before 11pm locks at 11pm the same LA day; an order placed
 * after 11pm locks at 11pm the NEXT LA day. Display-only - real eligibility
 * is always the live Printify production status.
 */

const CUTOFF_HOUR_LA = 23;

/** Milliseconds the LA wall clock is ahead of UTC at the given instant (negative). */
function laOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // hour can render as "24" at midnight with hour12:false; normalize.
  const hour = get('hour') % 24;
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** 11pm LA on the given instant's LA calendar day, as a UTC Date. */
function cutoffOfLaDay(at: Date): Date {
  const offset = laOffsetMs(at);
  const la = new Date(at.getTime() + offset);
  const candidateUtc =
    Date.UTC(la.getUTCFullYear(), la.getUTCMonth(), la.getUTCDate(), CUTOFF_HOUR_LA, 0, 0) - offset;
  return new Date(candidateUtc);
}

/** The next production cutoff at or after the order's creation. */
export function productionCutoff(createdAt: Date): Date {
  const sameDay = cutoffOfLaDay(createdAt);
  if (sameDay.getTime() > createdAt.getTime()) return sameDay;
  // Created after 11pm LA - next day's cutoff (jump 24h in, recompute for DST).
  return cutoffOfLaDay(new Date(createdAt.getTime() + 24 * 60 * 60 * 1000));
}
