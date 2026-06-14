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

    // Facebook auto-opens a Messenger chat that mirrors an ad comment, so the
    // same interaction lands in BOTH the Comments tab and here. If that comment
    // has already been handled (marked DONE), drop the duplicate from Messages
    // so handling it once clears it from both places.
    const norm = (s?: string | null) =>
      (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const names = [
      ...new Set(conversations.map((c) => c.participantName).filter(Boolean)),
    ];
    const accountIds = [...new Set(conversations.map((c) => c.accountId))];
    const handledComments =
      names.length > 0
        ? await prisma.socialComment.findMany({
            where: {
              status: 'DONE',
              accountId: { in: accountIds },
              authorName: { in: names },
            },
            select: { accountId: true, authorName: true, message: true },
          })
        : [];

    const visible = conversations.filter((c) => {
      const snip = norm(c.snippet);
      if (!snip) return true; // nothing to match on - keep it
      const name = norm(c.participantName);
      const mirroredDoneComment = handledComments.some(
        (h) =>
          h.accountId === c.accountId &&
          norm(h.authorName) === name &&
          (norm(h.message).startsWith(snip.slice(0, 40)) ||
            snip.startsWith(norm(h.message).slice(0, 40)))
      );
      return !mirroredDoneComment;
    });

    return NextResponse.json({ conversations: visible });
  } catch (err) {
    console.error('Error listing conversations:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
