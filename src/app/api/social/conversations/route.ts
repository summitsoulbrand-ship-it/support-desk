/**
 * Messenger conversations list
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const status = request.nextUrl.searchParams.get('status');

    const conversations = await prisma.socialConversation.findMany({
      where: status ? { status: status as never } : undefined,
      orderBy: { lastMessageAt: 'desc' },
      take: 100,
      include: {
        account: { select: { name: true, profilePictureUrl: true } },
      },
    });

    return NextResponse.json({ conversations });
  } catch (err) {
    console.error('Error listing conversations:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
