/**
 * Sidebar badge counts - open work per channel.
 */

import { NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { cacheGet } from '@/lib/cache';

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

    const [
      openEmails,
      newComments,
      openConversations,
      reviewAttention,
      manualThreads,
      failedRelinks,
    ] = await Promise.all([
      // Match the Email inbox's default "All" view exactly: OPEN/PENDING and
      // NOT Design-tagged (Design threads live in their own folder, so they
      // must not inflate this badge above what the inbox actually lists).
      prisma.thread.count({
        where: {
          status: { in: ['OPEN', 'PENDING'] },
          tags: {
            none: { tag: { name: { equals: 'Design', mode: 'insensitive' } } },
          },
        },
      }),
      prisma.socialComment.count({
        where: { status: 'NEW', deleted: false, hidden: false, isPageOwner: false },
      }),
      prisma.socialConversation.count({
        // Real DMs only - exclude Facebook's auto-created comment-mirror chats
        // (handled in the Comments tab) so the badge matches the Messages list.
        where: {
          status: { in: ['NEW', 'IN_PROGRESS'] },
          messages: {
            none: {
              message: { startsWith: 'Facebook created this chat', mode: 'insensitive' },
            },
          },
        },
      }),
      prisma.reviewDraft.count({
        where: { status: { in: ['READY', 'PENDING', 'FAILED'] } },
      }),
      prisma.thread.count({ where: { needsManual: true, manualResolvedAt: null } }),
      prisma.orderRelink.count({ where: { status: 'FAILED' } }),
    ]);

    // Failed AI drafts on still-open threads
    const failedDrafts = await prisma.aiDraft.count({
      where: {
        status: 'FAILED',
        thread: { status: { in: ['OPEN', 'PENDING'] } },
      },
    });

    // Late deliveries: read the cached late-orders result only - never trigger
    // the expensive live Printify pull from this 60s-polled badge. Count just
    // the unresolved ones (no replacement, refund, or manual solve), matching
    // the "Needs action" tab on the late-orders page. 13 days is the default
    // threshold the page uses, so we read that cache key.
    let lateDeliveries = 0;
    try {
      const cached = await cacheGet<{
        orders?: {
          replacement: unknown;
          refund: unknown;
          manualSolved: boolean;
        }[];
      }>('late-orders:v1:13');
      if (cached?.orders) {
        lateDeliveries = cached.orders.filter(
          (o) => !o.replacement && !o.refund && !o.manualSolved
        ).length;
      }
    } catch {
      // best-effort badge; leave at 0 on any cache error
    }

    return NextResponse.json({
      emails: openEmails,
      social: newComments + openConversations,
      reviews: reviewAttention,
      needsAttention: manualThreads + failedRelinks + failedDrafts,
      lateDeliveries,
    });
  } catch (err) {
    console.error('Error fetching nav counts:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
