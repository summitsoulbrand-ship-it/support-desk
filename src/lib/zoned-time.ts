/**
 * Wall-clock scheduling in a named time zone.
 *
 * The existing Manila helper in `eod-reminder.ts` can assume a fixed UTC+8
 * offset because the Philippines has no daylight saving. Pati's own zone does,
 * so a job that should fire at 8pm Eastern needs the real offset for the
 * instant in question, not a constant. This computes it from the runtime's own
 * zone database via Intl, so it stays correct across DST transitions and
 * whenever the rules change.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading in `timeZone` at instant `date`. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const get = (type: string) => {
    const found = parts.find((p) => p.type === type)?.value ?? '0';
    return parseInt(found, 10);
  };

  // Intl can report midnight as hour 24 in some runtimes; normalize it.
  const hour = get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: hour === 24 ? 0 : hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/** The zone's offset from UTC, in ms, at the given instant. */
function offsetMsAt(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which the wall clock in `timeZone` reads the given local
 * date at `hour`:00. Resolved twice because the offset itself depends on the
 * instant: the first pass lands close enough that the second uses the correct
 * side of any DST boundary.
 */
function instantForLocalHour(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string
): number {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
  let instant = wallAsUtc;
  for (let i = 0; i < 2; i++) {
    instant = wallAsUtc - offsetMsAt(new Date(instant), timeZone);
  }
  return instant;
}

/**
 * Milliseconds until the next time it is `hour` o'clock in `timeZone`.
 * Always strictly positive: called exactly on the hour it returns a full day
 * rather than zero, so a firing job cannot immediately retrigger itself.
 */
export function msUntilNextZonedHour(
  hour: number,
  timeZone: string,
  now = new Date()
): number {
  const today = zonedParts(now, timeZone);
  let target = instantForLocalHour(today.year, today.month, today.day, hour, timeZone);

  if (target <= now.getTime()) {
    const nextDay = new Date(Date.UTC(today.year, today.month - 1, today.day) + DAY_MS);
    target = instantForLocalHour(
      nextDay.getUTCFullYear(),
      nextDay.getUTCMonth() + 1,
      nextDay.getUTCDate(),
      hour,
      timeZone
    );
  }

  return target - now.getTime();
}
