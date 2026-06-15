/**
 * Suppress the thread's customer in Klaviyo (honor a "STOP" / unsubscribe).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { suppressKlaviyoProfile } from '@/lib/klaviyo/suppress';
import { logAction } from '@/lib/audit';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!hasPermission(session.user.role, 'CHANGE_STATUS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id: threadId } = await context.params;
    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      select: { customerEmail: true },
    });
    if (!thread?.customerEmail) {
      return NextResponse.json(
        { error: 'No customer email on this thread' },
        { status: 400 }
      );
    }

    const result = await suppressKlaviyoProfile(thread.customerEmail);
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    await logAction({
      threadId,
      userId: session.user.id,
      userName: session.user.name || session.user.email || 'Unknown',
      action: 'suppress_marketing',
      summary: `Unsubscribed ${thread.customerEmail} from email marketing (Klaviyo)`,
      metadata: { email: thread.customerEmail },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error suppressing profile:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
