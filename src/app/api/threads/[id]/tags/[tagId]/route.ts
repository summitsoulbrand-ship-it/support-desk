/**
 * Thread Tag API - remove a tag from a thread
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';

interface RouteParams {
  params: Promise<{ id: string; tagId: string }>;
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id, tagId } = await params;
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'REPLY_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Check if the thread tag exists
    const threadTag = await prisma.threadTag.findUnique({
      where: {
        threadId_tagId: {
          threadId: id,
          tagId,
        },
      },
    });

    if (!threadTag) {
      return NextResponse.json({ error: 'Tag not on thread' }, { status: 404 });
    }

    await prisma.threadTag.delete({
      where: {
        threadId_tagId: {
          threadId: id,
          tagId,
        },
      },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error removing thread tag:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
