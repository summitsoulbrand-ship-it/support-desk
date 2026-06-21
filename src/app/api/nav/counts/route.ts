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
      openComments,
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
      // Match the Social page's "Comments" open tab EXACTLY (status
      // NEW/IN_PROGRESS/ESCALATED, top-level only, not the page's own
      // comments). The list view only shows top-level comments, so without
      // parentId:null the badge counted every NEW reply too and ran far above
      // what the tab lists (e.g. 67 vs 4).
      prisma.socialComment.count({
        where: {
          status: { in: ['NEW', 'IN_PROGRESS', 'ESCALATED'] },
          parentId: null,
          isPageOwner: false,
          deleted: false,
        },
      }),
      prisma.socialConversation.count({
        // Real DMs only - exclude Facebook's auto-created comment-mirror chats
        // (handled in the Comments tab) so the badge matches the Messages list.
        // "Open" = anything not DONE, matching the Messages tab's own count.
        where: {
          status: { not: 'DONE' },
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
        orders?: { resolved?: boolean }[];
      }>('late-orders:v1:13');
      if (cached?.orders) {
        lateDeliveries = cached.orders.filter((o) => !o.resolved).length;
      }
    } catch {
      // best-effort badge; leave at 0 on any cache error
    }

    // Pending Printify escalations also live in the Needs Attention tab.
    const pendingEscalations = await prisma.printifyEscalation.count({
      where: { status: 'PENDING' },
    });

    return NextResponse.json({
      emails: openEmails,
      social: openComments + openConversations,
      reviews: reviewAttention,
      needsAttention: manualThreads + failedRelinks + failedDrafts + pendingEscalations,
      lateDeliveries,
    });
  } catch (err) {
    console.error('Error fetching nav counts:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
