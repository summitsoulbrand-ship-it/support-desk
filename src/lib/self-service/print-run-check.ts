/**
 * Daily check: is Printify's nightly print run still when the portal thinks?
 *
 * Every deadline the portal shows, and the payment window for a paid size
 * swap, is derived from PRINTIFY_PRINT_RUN_START_UTC (see cutoff.ts). That
 * value describes something we do not control, and it has moved without
 * warning: 05:00 UTC in March 2026, 06:00 from April, 07:00 since mid-July. The
 * portal was verified against 06:04 four days before the last move and nobody
 * noticed for two months - until #35734 was offered six hours to pay for a swap
 * thirteen minutes before it printed.
 *
 * So measure it instead of trusting it: the busiest ten-minute bucket of
 * sent_to_production_at over the last few days IS the run. If that is not where
 * the setting says, say so, with the exact value to set.
 *
 * The direction matters. A run LATER than configured only closes the portal
 * early. A run EARLIER than configured promises customers time that does not
 * exist - the alert says which.
 */

import prisma from '@/lib/db';
import { printRunStartUtc } from '@/lib/self-service/cutoff';
import { notifySelfServiceFailure } from '@/lib/self-service/alerts';

/** Anything closer than this to the setting is the same run (batches go out at :00, :10, :30). */
const TOLERANCE_MIN = 20;
/** Fewer native orders than this over the window is too little to call a time. */
const MIN_SAMPLES = 60;

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
  return h * 60 + m;
};

/** Signed minutes from `configured` to `measured` on a 24h clock: negative = the run is EARLIER. */
export function minutesFromConfigured(measured: string, configured: string): number {
  let d = toMinutes(measured) - toMinutes(configured);
  if (d > 12 * 60) d -= 24 * 60;
  if (d < -12 * 60) d += 24 * 60;
  return d;
}

export function printRunHasDrifted(measured: string, configured: string): boolean {
  return Math.abs(minutesFromConfigured(measured, configured)) >= TOLERANCE_MIN;
}

/**
 * The busiest ten-minute bucket (UTC, "HH:MM") in which Printify sent this
 * shop's own orders to production. Null when there is too little to go on.
 * Replacement orders are sent the moment they are created, at any hour, so the
 * MODE is used - they can never outvote the nightly run.
 */
export async function measurePrintRunStartUtc(
  days = 3
): Promise<{ bucket: string; orders: number; sampled: number } | null> {
  const rows = await prisma.$queryRaw<{ bucket: string; orders: number }[]>`
    SELECT to_char(
             date_trunc('hour', ts) + floor(extract(minute from ts) / 10) * interval '10 min',
             'HH24:MI'
           ) AS bucket,
           count(*)::int AS orders
    FROM (
      SELECT ((data->>'sent_to_production_at')::timestamptz AT TIME ZONE 'UTC') AS ts
      FROM printify_orders
      WHERE created_at > now() - make_interval(days => ${days}::int)
        AND data->>'sent_to_production_at' IS NOT NULL
        AND metadata_shop_order_id ~ '^[0-9]+$'
    ) x
    GROUP BY 1
    ORDER BY 2 DESC`;
  const sampled = rows.reduce((a, r) => a + r.orders, 0);
  if (rows.length === 0 || sampled < MIN_SAMPLES) return null;
  return { bucket: rows[0].bucket, orders: rows[0].orders, sampled };
}

export async function checkPrintRunDrift(): Promise<void> {
  const configured = printRunStartUtc();
  const measured = await measurePrintRunStartUtc();
  if (!measured) {
    console.log('[print-run-check] too few printed orders in the last 3 days to measure the run');
    return;
  }
  const diff = minutesFromConfigured(measured.bucket, configured);
  console.log(
    `[print-run-check] configured ${configured} UTC, measured ${measured.bucket} UTC ` +
      `(${measured.orders} of ${measured.sampled} orders), diff ${diff} min`
  );
  if (!printRunHasDrifted(measured.bucket, configured)) return;

  const earlier = diff < 0;
  await notifySelfServiceFailure({
    flow: 'status',
    orderName: 'all orders (print-run time)',
    step: "compare Printify's real print time with the customer portal's setting",
    error:
      `Printify now sends orders to print at about ${measured.bucket} UTC ` +
      `(${measured.orders} of the last ${measured.sampled} orders), but the portal is set to ${configured} UTC - ` +
      `${Math.abs(diff)} minutes ${earlier ? 'LATER than reality' : 'earlier than reality'}.` +
      (earlier
        ? ' Customers are being shown time to change, cancel or pay for a swap that they do not have.'
        : ' Harmless for customers (the portal closes early), but the numbers are out of step.'),
    humanAction:
      `On Railway set PRINTIFY_PRINT_RUN_START_UTC=${measured.bucket} on BOTH support-desk services, ` +
      'and UPSELL_BLACKOUT_START_UTC ten minutes before it / UPSELL_BLACKOUT_END_UTC thirty minutes after it on the worker. ' +
      'If the change is an hour and the clocks just changed, that is expected - the run is fixed in UTC.',
    detail: { configured, measured: measured.bucket, diffMinutes: diff },
  });
}
