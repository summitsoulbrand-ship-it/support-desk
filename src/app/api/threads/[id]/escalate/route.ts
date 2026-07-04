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
import { z } from 'zod';

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
      select: { id: true, subject: true },
    });
    if (!thread) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    }

    const who = session.user.name || session.user.email || 'operator';
    await prisma.thread.update({
      where: { id: threadId },
      data: {
        needsManual: true,
        manualReason:
          body.reason?.trim() || `Escalated by ${who} for review before replying`,
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

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[threads/escalate] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
