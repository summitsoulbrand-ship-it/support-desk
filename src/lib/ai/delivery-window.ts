/**
 * Estimated arrival window for a made-to-order order that has NOT shipped yet
 * (the common "when will it arrive?" case with no carrier ETA). Anchored to a
 * `now` so we never quote a date in the past for an older or delayed order.
 */

/** Add N business days (skipping Sat/Sun) to a date. */
export function addBusinessDays(date: Date, days: number): Date {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

export interface DeliveryWindow {
  earliest: Date;
  latest: Date;
}

/**
 * Estimated arrival window when there is no carrier ETA yet, from the order date
 * plus our timeline: production + 2-5 business days shipping.
 *
 * Production days depend on whether it has shipped:
 *  - NOT shipped: assume the FULL production time (4 business days) - we cannot
 *    assume it is already partway printed. earliest = 4 prod + 2 ship = order+6,
 *    latest = 4 prod + 5 ship = order+9.
 *  - shipped (no carrier ETA): production is done, so 1 production day.
 *    earliest = order+3, latest = order+6.
 *
 * The window is then floored to `now` + 2 / `now` + 5 business days, so an order
 * placed days ago never produces a past/impossible arrival date (it cannot
 * arrive before it ships).
 */
export function estimateArrivalWindow(
  createdAt: string | Date,
  hasShipped: boolean = false,
  now: Date = new Date()
): DeliveryWindow {
  const created = new Date(createdAt);
  const productionDays = hasShipped ? 1 : 4;
  let earliest = addBusinessDays(created, productionDays + 2);
  let latest = addBusinessDays(created, productionDays + 5);
  const floorEarliest = addBusinessDays(now, 2);
  const floorLatest = addBusinessDays(now, 5);
  if (earliest.getTime() < floorEarliest.getTime()) earliest = floorEarliest;
  if (latest.getTime() < floorLatest.getTime()) latest = floorLatest;
  return { earliest, latest };
}
