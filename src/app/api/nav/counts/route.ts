/**
 * Sidebar badge counts - open work per channel.
 */

import { NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { cacheGet } from '@/lib/cache';
import {
  openThreadsWhere,
  openSocialCommentsWhere,
  openSocialConversationsWhere,
  reviewsAttentionWhere,
  manualAttentionWhere,
  failedDraftsWhere,
  failedRelinksWhere,
  pendingEscalationsWhere,
} from '@/lib/queues';

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

    // Every count uses the shared where-clause from lib/queues, so each badge
    // matches EXACTLY what its page lists (badge/page drift is what these
    // helpers exist to prevent). All queries run in one parallel batch.
    const [
      openEmails,
      openComments,
      openConversations,
      reviewAttention,
      manualThreads,
      failedRelinks,
      failedDrafts,
      pendingEscalations,
      lateOrdersCache,
    ] = await Promise.all([
      prisma.thread.count({ where: openThreadsWhere() }),
      prisma.socialComment.count({ where: openSocialCommentsWhere() }),
      prisma.socialConversation.count({ where: openSocialConversationsWhere() }),
      prisma.reviewDraft.count({ where: reviewsAttentionWhere() }),
      prisma.thread.count({ where: manualAttentionWhere() }),
      prisma.orderRelink.count({ where: failedRelinksWhere() }),
      prisma.aiDraft.count({ where: failedDraftsWhere() }),
      prisma.printifyEscalation.count({ where: pendingEscalationsWhere() }),
      // Late deliveries: read the cached late-orders result only - never
      // trigger the expensive live Printify pull from this 60s-polled badge.
      // 13 days is the default threshold the page uses, so we read that key.
      cacheGet<{ orders?: { resolved?: boolean }[] }>('late-orders:v1:13').catch(
        () => null
      ),
    ]);

    // Count just the unresolved late orders (no replacement, refund, or manual
    // solve), matching the "Needs action" tab on the late-orders page. When
    // the cache is cold the real count is UNKNOWN - report null (the client
    // renders nothing) instead of a false 0.
    const lateDeliveries = lateOrdersCache?.orders
      ? lateOrdersCache.orders.filter((o) => !o.resolved).length
      : null;

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
