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

/**
 * When Printify's nightly print run REALLY starts, as a UTC time of day.
 *
 * The 11pm above is what customers are TOLD; this is what Printify DOES, and
 * they are not the same. Measured 2026-09-19 over 30 days of orders: 2,784 sent
 * to production at 07:00-07:09 UTC, 761 at 07:10-07:19, 188 at 07:30-07:39 -
 * midnight to 12:40am PDT, an hour after the 11pm shown. And it DRIFTS: 05:00
 * UTC in March, 06:00 from April, 07:00 since mid-July 2026 (this file was
 * verified against 06:04 on 2026-07-11, days before it moved).
 *
 * For an order placed during the day the gap is harmless - the portal simply
 * closes an hour early. It is NOT harmless for an order placed between 11pm LA
 * and the run: the old model gave it until 11pm the NEXT day, while 30 of 31
 * such orders printed the SAME night, 43 minutes after being placed on average.
 * #35734 (2026-08-23) was offered six hours to pay for a size swap 13 minutes
 * before it went to print, and the unpaid change could then never be undone.
 *
 * Kept in UTC because that is how the run has actually behaved. If it moves,
 * change PRINTIFY_PRINT_RUN_START_UTC (and UPSELL_BLACKOUT_START_UTC, which
 * sits ten minutes before it) - the worker's daily print-run check says when.
 */
const DEFAULT_PRINT_RUN_START_UTC = '07:00';

/** The run sends orders in batches for about 40 minutes (07:00, 07:10, 07:30). */
const PRINT_RUN_WINDOW_MS = 45 * 60 * 1000;

export function printRunStartUtc(): string {
  const raw = (process.env.PRINTIFY_PRINT_RUN_START_UTC || '').trim();
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : DEFAULT_PRINT_RUN_START_UTC;
}

/**
 * The real print run this instant has to beat. While a run is in progress the
 * answer is that run's start (already past): a late batch can still take an
 * order placed minutes ago, so "it is printing now" is the only safe reading.
 */
export function nextPrintRun(at: Date): Date {
  const [h, m] = printRunStartUtc().split(':').map((x) => parseInt(x, 10));
  const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), h, m, 0);
  // UTC days are always 24h, so stepping a day needs no DST care.
  if (at.getTime() < start + PRINT_RUN_WINDOW_MS) return new Date(start);
  return new Date(start + 24 * 60 * 60 * 1000);
}

/** The 11pm-LA cutoff customers are shown, at or after the order's creation. */
function displayedCutoff(createdAt: Date): Date {
  const sameDay = cutoffOfLaDay(createdAt);
  if (sameDay.getTime() > createdAt.getTime()) return sameDay;
  // Created after 11pm LA - the NEXT LA day's cutoff. Step from the 11pm
  // cutoff by 12h, which lands mid-next-LA-day whether that day has 23, 24
  // or 25 hours (a flat +24h from createdAt skips the short spring-forward
  // day entirely and computes the cutoff a full day late).
  return cutoffOfLaDay(new Date(sameDay.getTime() + 12 * 60 * 60 * 1000));
}

/**
 * When this order locks: the 11pm shown to customers, or the real print run if
 * that comes FIRST. For a daytime order that is still 11pm, exactly as before.
 * For an order placed after 11pm it is tonight's run, minutes away - not 11pm
 * tomorrow. The countdown and the paid-swap payment window both derive from
 * this, so neither can promise time that does not exist.
 */
export function productionCutoff(createdAt: Date): Date {
  const shown = displayedCutoff(createdAt);
  const run = nextPrintRun(createdAt);
  return run.getTime() < shown.getTime() ? run : shown;
}
