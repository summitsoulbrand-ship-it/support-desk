/**
 * Sidebar badge counts - open work per channel.
 */

import { NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const [openEmails, newComments, openConversations, reviewAttention] =
      await Promise.all([
        prisma.thread.count({ where: { status: { in: ['OPEN', 'PENDING'] } } }),
        prisma.socialComment.count({
          where: { status: 'NEW', deleted: false, hidden: false, isPageOwner: false },
        }),
        prisma.socialConversation.count({
          where: { status: { in: ['NEW', 'IN_PROGRESS'] } },
        }),
        prisma.reviewDraft.count({
          where: { status: { in: ['READY', 'PENDING', 'FAILED'] } },
        }),
      ]);

    return NextResponse.json({
      emails: openEmails,
      social: newComments + openConversations,
      reviews: reviewAttention,
    });
  } catch (err) {
    console.error('Error fetching nav counts:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
