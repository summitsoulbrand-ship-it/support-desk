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
 * The order has NOT shipped yet, so assume the FULL production time (up to 4
 * business days) still applies - we cannot assume it is already partway printed.
 * From the order date: earliest = 4 prod + 2 ship = 6 business days; latest =
 * 4 prod + 5 ship = 9. The window is then floored to `now` + 2 / `now` + 5
 * business days, so an order placed days ago never produces a past/impossible
 * arrival date (it still cannot arrive before it ships).
 */
export function unshippedDeliveryWindow(
  createdAt: string | Date,
  now: Date = new Date()
): DeliveryWindow {
  const created = new Date(createdAt);
  let earliest = addBusinessDays(created, 6);
  let latest = addBusinessDays(created, 9);
  const floorEarliest = addBusinessDays(now, 2);
  const floorLatest = addBusinessDays(now, 5);
  if (earliest.getTime() < floorEarliest.getTime()) earliest = floorEarliest;
  if (latest.getTime() < floorLatest.getTime()) latest = floorLatest;
  return { earliest, latest };
}
