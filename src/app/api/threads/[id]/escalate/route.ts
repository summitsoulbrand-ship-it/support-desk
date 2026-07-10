/**
 * Escalate a thread to Pati: flags it for the Needs Attention queue instead
 * of the operator talking themselves into sending a risky reply. Used by the
 * escalation banner the composer shows agents on high-risk threads (angry
 * customer, wholesale, legal wording), and available on any thread.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { logAction } from '@/lib/audit';
import { postToSlack } from '@/lib/slack';
import { createOutboundEmailSender } from '@/lib/email';
import { z } from 'zod';

/** Nudge Pati the moment something is escalated - best-effort, never fails
 *  the escalation itself. Same recipient convention as the eval/digest. */
async function emailEscalationNotice(input: {
  threadId: string;
  subject: string;
  customerEmail: string;
  customerName: string | null;
  reason: string;
  who: string;
}): Promise<void> {
  try {
    const to =
      process.env.ESCALATION_EMAIL_TO ||
      process.env.EVAL_EMAIL_TO ||
      'summitsoulbrand@gmail.com';
    const base = process.env.NEXTAUTH_URL || 'https://selfservice.summitsoul.shop';
    const link = `${base}/inbox?thread=${input.threadId}`;
    const customer = input.customerName
      ? `${input.customerName} (${input.customerEmail})`
      : input.customerEmail;

    // Mirror to Slack (best-effort, independent of email)
    void postToSlack(
      `:rotating_light: *${input.who}* escalated a thread from *${customer}*\n` +
        `"${input.subject || '(no subject)'}"\n${input.reason}\n${link}`
    );

    const sender = await createOutboundEmailSender();
    if (!sender) return;
    try {
      await sender.sendMessage({
        to: [{ address: to }],
        fromName: 'Summit Soul Desk',
        subject: `Escalated: ${input.subject || '(no subject)'}`,
        bodyHtml:
          `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px">` +
          `<h2 style="color:#9a3412">A thread was escalated to you</h2>` +
          `<p><b>${escapeHtml(input.who)}</b> escalated a thread from <b>${escapeHtml(customer)}</b>.</p>` +
          `<p style="padding:8px 12px;border-left:3px solid #fb923c;background:#fff7ed">${escapeHtml(input.reason)}</p>` +
          `<p><a href="${link}">Open the thread</a> - it is also in Needs attention.</p>` +
          `</div>`,
        bodyText:
          `${input.who} escalated "${input.subject}" from ${customer}.\n` +
          `Reason: ${input.reason}\n${link}`,
      });
    } finally {
      await sender.disconnect().catch(() => undefined);
    }
  } catch (err) {
    console.error('[threads/escalate] notification email failed:', err);
  }
}

function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const bodySchema = z.object({
  reason: z.string().max(500).optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!hasPermission(session.user.role, 'REPLY_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id: threadId } = await context.params;
    const body = bodySchema.parse(await request.json().catch(() => ({})));

    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      select: {
        id: true,
        subject: true,
        customerEmail: true,
        customerName: true,
      },
    });
    if (!thread) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    }

    const who = session.user.name || session.user.email || 'operator';
    const reason =
      body.reason?.trim() || `Escalated by ${who} for review before replying`;
    await prisma.thread.update({
      where: { id: threadId },
      data: {
        needsManual: true,
        manualReason: reason,
        manualResolvedAt: null,
      },
    });

    await logAction({
      threadId,
      userId: session.user.id,
      userName: who,
      action: 'thread_escalated',
      summary: body.reason?.trim() || 'Escalated for review',
    });

    await emailEscalationNotice({
      threadId,
      subject: thread.subject || '',
      customerEmail: thread.customerEmail,
      customerName: thread.customerName,
      reason,
      who,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[threads/escalate] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
