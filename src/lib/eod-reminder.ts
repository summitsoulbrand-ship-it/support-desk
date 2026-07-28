/**
 * End-of-day report reminder.
 *
 * Nothing used to chase a missing report: if the agent forgot to open /eod,
 * the channel simply stayed quiet, which looks exactly like a broken feature.
 * Once a day, at the end of her shift, this checks whether a report was filed
 * and posts a nudge to the same channel when it wasn't.
 */

import prisma from '@/lib/db';
import { postToEodReport } from '@/lib/slack';

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000; // PHT is UTC+8, no DST
const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the current Manila calendar day, as a UTC Date. */
export function startOfManilaDay(now = new Date()): Date {
  const shifted = new Date(now.getTime() + MANILA_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - MANILA_OFFSET_MS);
}

/**
 * Milliseconds from `now` until the next time it is `hour` o'clock in Manila.
 * Always strictly positive: at exactly 18:00 it returns a full day, so firing
 * can't retrigger itself.
 */
export function msUntilNextManilaHour(hour: number, now = new Date()): number {
  const dayStart = startOfManilaDay(now).getTime();
  let target = dayStart + hour * 60 * 60 * 1000;
  while (target <= now.getTime()) target += DAY_MS;
  return target - now.getTime();
}

export interface EodReminderResult {
  reported: boolean;
  sent: boolean;
}

/**
 * Nudge unless a report has already come in today. The caller owns the
 * timing - this only answers "has one been filed since midnight Manila?".
 */
export async function maybeSendEodReminder(
  now = new Date()
): Promise<EodReminderResult> {
  const reported = await prisma.actionLog.findFirst({
    where: { action: 'eod_report', createdAt: { gte: startOfManilaDay(now) } },
    select: { id: true },
  });
  if (reported) return { reported: true, sent: false };

  const sent = await postToEodReport(
    ':hourglass: No end-of-day report has come in today yet. ' +
      'A reminder to fill it in at /eod before signing off.'
  );
  return { reported: false, sent };
}
