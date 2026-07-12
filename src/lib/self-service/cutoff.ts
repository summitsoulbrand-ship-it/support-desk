/**
 * The production cutoff clock. Printify's nightly sweep sends everything to
 * production around 11pm America/Los_Angeles (verified 2026-07-11 from our
 * own replacement orders: sent_to_production_at ~06:04 UTC = 11:04pm PDT).
 *
 * An order placed before 11pm locks at 11pm the same LA day; an order placed
 * after 11pm locks at 11pm the NEXT LA day. Display-only - real eligibility
 * is always the live Printify production status.
 */

/**
 * Whole hour (0-23, America/Los_Angeles) when Printify sends orders to
 * production. Configurable so a changed Printify approval time is one env
 * edit on Railway: PRODUCTION_CUTOFF_HOUR_LA. Keep it in sync with the real
 * Printify setting - the countdown, the pricier-swap payment window, and the
 * customer copy all derive from this.
 */
function cutoffHourLa(): number {
  const raw = parseInt(process.env.PRODUCTION_CUTOFF_HOUR_LA || '23', 10);
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : 23;
}

/** "11pm Pacific" / "9am Pacific" for customer copy. */
export function cutoffHourHuman(): string {
  const h = cutoffHourLa();
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${h < 12 ? 'am' : 'pm'} Pacific`;
}

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

/**
 * 11pm LA on the given instant's LA calendar day, as a UTC Date.
 *
 * The offset at `at` can differ from the offset at 11pm that same day (an
 * order placed 00:30 on a DST-transition day), which would land the cutoff
 * an hour off the real sweep - so refine once with the offset AT the
 * candidate itself (a second pass always converges: the candidate stays
 * within the same LA day).
 */
function cutoffOfLaDay(at: Date): Date {
  let offset = laOffsetMs(at);
  const la = new Date(at.getTime() + offset);
  const wallUtc = Date.UTC(
    la.getUTCFullYear(),
    la.getUTCMonth(),
    la.getUTCDate(),
    cutoffHourLa(),
    0,
    0
  );
  let candidate = new Date(wallUtc - offset);
  const refined = laOffsetMs(candidate);
  if (refined !== offset) {
    offset = refined;
    candidate = new Date(wallUtc - offset);
  }
  return candidate;
}

/** The next production cutoff at or after the order's creation. */
export function productionCutoff(createdAt: Date): Date {
  const sameDay = cutoffOfLaDay(createdAt);
  if (sameDay.getTime() > createdAt.getTime()) return sameDay;
  // Created after 11pm LA - the NEXT LA day's cutoff. Step from the 11pm
  // cutoff by 12h, which lands mid-next-LA-day whether that day has 23, 24
  // or 25 hours (a flat +24h from createdAt skips the short spring-forward
  // day entirely and computes the cutoff a full day late).
  return cutoffOfLaDay(new Date(sameDay.getTime() + 12 * 60 * 60 * 1000));
}
