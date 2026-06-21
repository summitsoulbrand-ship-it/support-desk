/**
 * Bulk-like friend-tag comments: likes up to a batch of open TAG-category
 * Facebook comments (a like acknowledges the tag, and liking auto-closes
 * them). The UI calls repeatedly until `remaining` hits 0 - small batches
 * with spacing keep Meta rate limits comfortable.
 */

import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getSession, hasPermission } from '@/lib/auth';
import { createMetaClient } from '@/lib/social/meta-client';
// isLikeable is shared with the background auto-like sweep so the manual and
// automatic paths agree on exactly what is safe to like.
import { isLikeable } from '@/lib/social/auto-like';

// Small batches: the whole batch must finish well inside proxy timeouts
const BATCH = 10;
const SPACING_MS = 150;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST() {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!hasPermission(session.user.role, 'CHANGE_STATUS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Facebook comments can be liked via the API (a like acknowledges + closes
    // them). Instagram's API has NO like-a-comment endpoint, so IG tag/praise
    // comments are swept by simply closing them (acknowledged, off the list).
    const where = {
      status: 'NEW' as const,
      isPageOwner: false,
      deleted: false,
      hidden: false,
      parentId: null,
      platform: { in: ['FACEBOOK', 'INSTAGRAM'] as ('FACEBOOK' | 'INSTAGRAM')[] },
      category: { in: ['TAG', 'OTHER'] },
      isLikedByPage: false,
    };

    // Filterable set is small (open comments only) - fetch and filter in JS
    const candidates = await prisma.socialComment.findMany({
      where,
      orderBy: { commentedAt: 'desc' },
      take: 500,
      include: { account: { select: { externalId: true } } },
    });
    const likeable = candidates.filter((c) => isLikeable(c.category, c.message));
    const batch = likeable.slice(0, BATCH);

    let liked = 0;
    let closed = 0;
    let failed = 0;
    let rateLimited = false;
    const clients = new Map<string, Awaited<ReturnType<typeof createMetaClient>>>();

    for (const comment of batch) {
      // Instagram comments can't be liked through the API - just close them.
      if (comment.platform !== 'FACEBOOK') {
        await prisma.socialComment.update({
          where: { id: comment.id },
          data: { status: 'DONE' },
        });
        closed++;
        continue;
      }

      let client = clients.get(comment.account.externalId);
      if (client === undefined) {
        client = await createMetaClient(comment.account.externalId);
        clients.set(comment.account.externalId, client);
      }
      if (!client) {
        failed++;
        continue;
      }
      try {
        const result = await client.likeComment(comment.externalId);
        if (result.success) {
          await prisma.socialComment.update({
            where: { id: comment.id },
            data: { isLikedByPage: true, status: 'DONE' },
          });
          liked++;
        } else if (result.rateLimited) {
          // Throttled by Meta - STOP this batch and leave the comment NEW so
          // it is retried later. Never mark a rate-limited comment as handled.
          rateLimited = true;
          break;
        } else {
          // Can't be liked (deleted author etc.) - close it anyway so the
          // sweep terminates instead of retrying the same comment forever
          await prisma.socialComment.update({
            where: { id: comment.id },
            data: { status: 'DONE' },
          });
          failed++;
        }
      } catch {
        await prisma.socialComment.update({
          where: { id: comment.id },
          data: { status: 'DONE' },
        });
        failed++;
      }
      await wait(SPACING_MS);
    }

    // Leftover = everything we didn't actually handle this batch (so a
    // rate-limited stop reports the still-pending ones, not zero).
    const remaining = Math.max(0, likeable.length - liked - closed - failed);

    return NextResponse.json({ liked, closed, failed, remaining, rateLimited });
  } catch (err) {
    console.error('Bulk like failed:', err);
    return NextResponse.json({ error: 'Bulk like failed' }, { status: 500 });
  }
}
