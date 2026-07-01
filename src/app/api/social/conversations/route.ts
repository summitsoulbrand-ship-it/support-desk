/**
 * Messenger conversations list
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { FACEBOOK_COMMENT_MIRROR_PREFIX } from '@/lib/queues';

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

    // Real DMs only. Facebook auto-opens a Messenger chat mirroring every ad
    // comment, tagged with a "Facebook created this chat because ... commented"
    // system message. Those belong in the Comments tab, not here - exclude any
    // conversation carrying that marker. Customer-initiated DMs never have it.
    const convIds = conversations.map((c) => c.id);
    const mirrored = convIds.length
      ? await prisma.socialMessage.findMany({
          where: {
            conversationId: { in: convIds },
            message: { startsWith: FACEBOOK_COMMENT_MIRROR_PREFIX, mode: 'insensitive' },
          },
          select: { conversationId: true },
          distinct: ['conversationId'],
        })
      : [];
    const mirroredIds = new Set(mirrored.map((m) => m.conversationId));
    const visible = conversations.filter((c) => !mirroredIds.has(c.id));

    return NextResponse.json({ conversations: visible });
  } catch (err) {
    console.error('Error listing conversations:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
