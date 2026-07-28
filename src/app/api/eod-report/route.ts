/**
 * End-of-day report for the agent (VA).
 *
 * GET  -> today's auto-computed facts for the CURRENT user (replies sent,
 *         threads closed, escalations, replacements/refunds, social replies),
 *         "today" = the Manila working day.
 * POST -> submit the report: facts are recomputed server-side (never trust the
 *         client's numbers), the agent's own notes are appended, and the
 *         report posts to the Slack channel (email fallback when Slack is
 *         unavailable) plus the audit log.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import prisma from '@/lib/db';
import { logAction } from '@/lib/audit';
import { postToEodReport } from '@/lib/slack';
import { createOutboundEmailSender } from '@/lib/email';

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000; // PHT is UTC+8, no DST

/** Start of the current Manila calendar day, as a UTC Date. */
function startOfManilaDay(): Date {
  const shifted = new Date(Date.now() + MANILA_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - MANILA_OFFSET_MS);
}

function manilaDateLabel(): string {
  return new Date(Date.now() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

interface EodStats {
  date: string;
  repliesSent: number;
  threadsReplied: number;
  threadsClosed: number;
  escalations: number;
  replacements: number;
  refunds: number;
  cancellations: number;
  preproductionChanges: number;
  socialReplies: number;
  reviewReplies: number;
  printifyEscalations: number;
  lateOrdersHandled: number;
}

async function computeStats(user: {
  id: string;
  name?: string | null;
  email?: string | null;
}): Promise<EodStats> {
  const since = startOfManilaDay();
  const userId = user.id;
  // Some records attribute by NAME string (late-order resolutions, Printify
  // escalations), not user id - match on both name and email.
  const nameKeys = [user.name, user.email].filter(
    (v): v is string => !!v && v.trim().length > 0
  );

  const [sentMessages, actions, socialReplies, printifyEscalations, lateOrdersHandled] = await Promise.all([
    prisma.message.findMany({
      where: {
        sentByUserId: userId,
        direction: 'OUTBOUND',
        createdAt: { gte: since },
      },
      select: { threadId: true, thread: { select: { status: true } } },
    }),
    prisma.actionLog.groupBy({
      by: ['action'],
      where: { userId, createdAt: { gte: since } },
      _count: { id: true },
    }),
    prisma.socialActionLog.count({
      where: {
        actorId: userId,
        actionType: 'REPLY',
        apiSuccess: true,
        createdAt: { gte: since },
      },
    }),
    nameKeys.length > 0
      ? prisma.printifyEscalation.count({
          where: { createdBy: { in: nameKeys }, createdAt: { gte: since } },
        })
      : Promise.resolve(0),
    nameKeys.length > 0
      ? prisma.lateOrderResolution.count({
          where: { resolvedBy: { in: nameKeys }, updatedAt: { gte: since } },
        })
      : Promise.resolve(0),
  ]);

  const threadIds = new Set(sentMessages.map((m) => m.threadId));
  const closedIds = new Set(
    sentMessages
      .filter((m) => m.thread?.status === 'CLOSED')
      .map((m) => m.threadId)
  );
  const count = (names: string[]) =>
    actions
      .filter((a) => names.includes(a.action))
      .reduce((s, a) => s + a._count.id, 0);

  return {
    date: manilaDateLabel(),
    repliesSent: sentMessages.length,
    threadsReplied: threadIds.size,
    threadsClosed: closedIds.size,
    escalations: count(['thread_escalated']),
    replacements: count(['create_replacement']),
    refunds: count(['refund']),
    cancellations: count(['cancel_both', 'cancel_shopify', 'cancel_printify']),
    preproductionChanges: count(['change_preproduction']),
    socialReplies,
    reviewReplies: count(['review_reply']),
    printifyEscalations,
    lateOrdersHandled,
  };
}

export async function GET() {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const stats = await computeStats(session.user);
  return NextResponse.json({ stats, name: session.user.name || 'Agent' });
}

// Both free-text boxes are REQUIRED: the numbers arrive on their own, so the
// only thing the report can't produce without the agent is what she noticed.
// "Nothing today" is a perfectly good answer - a blank one is not.
const MIN_NOTE = 3;
const bodySchema = z.object({
  highlights: z
    .string()
    .trim()
    .min(MIN_NOTE, 'Please write something under "Anything worth sharing?"')
    .max(2000),
  blockers: z
    .string()
    .trim()
    .min(MIN_NOTE, 'Please write something under "Anything blocked or unclear?" - "Nothing today" is fine.')
    .max(2000),
});

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          parsed.error.issues[0]?.message ||
          'Please fill in both notes before sending the report.',
      },
      { status: 400 }
    );
  }
  const body = parsed.data;
  const stats = await computeStats(session.user);
  const who = session.user.name || session.user.email || 'Agent';

  const factLines = [
    `Replies sent: ${stats.repliesSent} (${stats.threadsReplied} threads, ${stats.threadsClosed} closed)`,
    stats.socialReplies > 0 ? `Social replies: ${stats.socialReplies}` : null,
    stats.replacements > 0 ? `Replacements created: ${stats.replacements}` : null,
    stats.refunds > 0 ? `Refunds issued: ${stats.refunds}` : null,
    stats.cancellations > 0 ? `Cancellations: ${stats.cancellations}` : null,
    stats.preproductionChanges > 0
      ? `Pre-production changes: ${stats.preproductionChanges}`
      : null,
    stats.reviewReplies > 0 ? `Review replies: ${stats.reviewReplies}` : null,
    stats.printifyEscalations > 0
      ? `Printify escalations filed: ${stats.printifyEscalations}`
      : null,
    stats.lateOrdersHandled > 0
      ? `Late deliveries handled: ${stats.lateOrdersHandled}`
      : null,
    stats.escalations > 0 ? `Escalated to Pati: ${stats.escalations}` : null,
  ].filter(Boolean);

  const slackText =
    `:clipboard: *End of day report - ${who} (${stats.date})*\n` +
    factLines.map((l) => `• ${l}`).join('\n') +
    `\n\n*Notes:*\n${body.highlights}` +
    `\n\n*Blockers / questions:*\n${body.blockers}`;

  let delivered = await postToEodReport(slackText);

  // Email fallback so the report is never lost when Slack is down/unset.
  if (!delivered) {
    try {
      const sender = await createOutboundEmailSender();
      if (sender) {
        const esc = (t: string) =>
          t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        await sender.sendMessage({
          to: [
            {
              address:
                process.env.ESCALATION_EMAIL_TO ||
                process.env.EVAL_EMAIL_TO ||
                'summitsoulbrand@gmail.com',
            },
          ],
          fromName: 'Summit Soul Desk',
          subject: `End of day report - ${who} (${stats.date})`,
          bodyHtml:
            `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px">` +
            `<h2>End of day report - ${esc(who)} (${stats.date})</h2>` +
            `<ul>${factLines.map((l) => `<li>${esc(l as string)}</li>`).join('')}</ul>` +
            `<h3>Notes</h3><p>${esc(body.highlights)}</p>` +
            `<h3>Blockers / questions</h3><p>${esc(body.blockers)}</p>` +
            `</div>`,
        });
        delivered = true;
      }
    } catch (err) {
      console.error('[eod-report] email fallback failed:', err);
    }
  }

  await logAction({
    userId: session.user.id,
    userName: who,
    action: 'eod_report',
    summary: `End of day report (${stats.repliesSent} replies, ${stats.threadsClosed} closed)`,
    metadata: { stats, highlights: body.highlights, blockers: body.blockers },
  });

  return NextResponse.json({ success: true, delivered, stats });
}
