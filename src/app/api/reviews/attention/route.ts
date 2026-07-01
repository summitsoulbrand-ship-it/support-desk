/**
 * Reviews needing attention - low-star (<=3) unanswered reviews with their
 * pre-written AI reply drafts, ready for the VA to review and publish.
 */

import { NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { reviewsAttentionWhere } from '@/lib/queues';
import { createJudgemeClient } from '@/lib/judgeme/client';

/**
 * Reconcile open drafts against Judge.me so reviews answered or hidden
 * OUTSIDE the tool (directly in Judge.me) drop off the queue immediately
 * instead of waiting for the next worker pass.
 */
async function reconcileWithJudgeme(reviewIds: number[]): Promise<Set<number>> {
  const resolved = new Set<number>();
  if (reviewIds.length === 0) return resolved;

  try {
    const judgeme = await createJudgemeClient();
    if (!judgeme) return resolved;

    for (let page = 1; page <= 2; page++) {
      const result = await judgeme.getRecentReviews(page, 24);
      for (const review of result.reviews) {
        if (
          reviewIds.includes(review.id) &&
          (review.replied || review.curated === 'spam')
        ) {
          resolved.add(review.id);
        }
      }
      if (page >= result.totalPages) break;
    }

    if (resolved.size > 0) {
      await prisma.reviewDraft.updateMany({
        where: { reviewId: { in: [...resolved] } },
        data: { status: 'HANDLED' },
      });
    }
  } catch (err) {
    console.error('Attention reconcile failed (non-fatal):', err);
  }
  return resolved;
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    let drafts = await prisma.reviewDraft.findMany({
      where: reviewsAttentionWhere(),
      orderBy: { reviewCreatedAt: 'desc' },
      take: 100,
    });

    // Drop anything already answered/hidden directly in Judge.me
    const resolved = await reconcileWithJudgeme(drafts.map((d) => d.reviewId));
    if (resolved.size > 0) {
      drafts = drafts.filter((d) => !resolved.has(d.reviewId));
    }

    return NextResponse.json({ drafts });
  } catch (err) {
    console.error('Error fetching attention reviews:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
