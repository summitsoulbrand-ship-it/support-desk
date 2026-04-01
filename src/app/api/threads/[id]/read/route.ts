/**
 * Mark thread messages as read
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';

type RouteParams = { params: Promise<{ id: string }> };

// POST - Mark all inbound messages in a thread as read
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await params;

    // Verify thread exists
    const thread = await prisma.thread.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!thread) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    }

    // Mark all unread inbound messages in this thread as read
    const result = await prisma.message.updateMany({
      where: {
        threadId: id,
        direction: 'INBOUND',
        isRead: false,
      },
      data: {
        isRead: true,
      },
    });

    return NextResponse.json({
      success: true,
      messagesMarkedRead: result.count,
    });
  } catch (err) {
    console.error('Error marking messages as read:', err);
    return NextResponse.json(
      { error: 'Failed to mark messages as read' },
      { status: 500 }
    );
  }
}
