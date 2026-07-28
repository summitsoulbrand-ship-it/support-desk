/**
 * End-of-day report reminder.
 *
 * Nothing used to chase a missing report: if the agent forgot to open /eod,
 * the channel simply stayed quiet, which looks exactly like a broken feature.
 * Once per Manila day, shortly after the shift ends, this checks whether an
 * eod_report was logged and posts a nudge to the same channel when it wasn't.
 */

import prisma from '@/lib/db';
import { postToEodReport } from '@/lib/slack';

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000; // PHT is UTC+8, no DST

/** Start of the current Manila calendar day, as a UTC Date. */
export function startOfManilaDay(now = new Date()): Date {
  const shifted = new Date(now.getTime() + MANILA_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - MANILA_OFFSET_MS);
}

/** Manila wall-clock hour (0-23) right now. */
export function manilaHour(now = new Date()): number {
  return new Date(now.getTime() + MANILA_OFFSET_MS).getUTCHours();
}

export interface EodReminderResult {
  due: boolean;
  reported: boolean;
  sent: boolean;
}

/**
 * Send the nudge when the day is past the reminder hour and no report has
 * been filed. Returns what it decided so the worker can log it.
 */
export async function maybeSendEodReminder(
  reminderHourManila: number,
  now = new Date()
): Promise<EodReminderResult> {
  if (manilaHour(now) < reminderHourManila) {
    return { due: false, reported: false, sent: false };
  }

  const reported = await prisma.actionLog.findFirst({
    where: { action: 'eod_report', createdAt: { gte: startOfManilaDay(now) } },
    select: { id: true },
  });
  if (reported) return { due: true, reported: true, sent: false };

  const sent = await postToEodReport(
    ':hourglass: No end-of-day report has come in today yet. ' +
      'A reminder to fill it in at /eod before signing off.'
  );
  return { due: true, reported: false, sent };
}
