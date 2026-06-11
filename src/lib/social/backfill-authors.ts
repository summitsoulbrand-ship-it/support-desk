/**
 * Author backfill
 * Comments synced while the Meta app was in Development Mode were stored with
 * authorName 'Unknown' (Meta withholds `from` for non-role users in dev mode).
 * Now that the app is Live, re-fetch those comments individually and fill in
 * the real author name/id/picture. Runs in small batches until none remain.
 */

import prisma from '@/lib/db';
import { createMetaClient } from './meta-client';

const BATCH = 25;

export interface AuthorBackfillStats {
  checked: number;
  updated: number;
  /** Meta still returns no author for these (e.g. deleted profiles) */
  stillUnknown: number;
}

export async function backfillCommentAuthors(): Promise<AuthorBackfillStats> {
  const stats: AuthorBackfillStats = { checked: 0, updated: 0, stillUnknown: 0 };

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const unknowns = await prisma.socialComment.findMany({
    where: {
      deleted: false,
      platform: 'FACEBOOK',
      OR: [
        { authorName: 'Unknown' },
        // Re-check 'Facebook user' stamps at most once a day - some were
        // marked while the app was still propagating to Live mode
        { authorName: 'Facebook user', updatedAt: { lt: dayAgo } },
      ],
    },
    orderBy: { commentedAt: 'desc' },
    take: BATCH,
    include: { account: { select: { externalId: true } } },
  });
  if (unknowns.length === 0) return stats;

  // Group by page so we reuse one client per account
  const byPage = new Map<string, typeof unknowns>();
  for (const c of unknowns) {
    const list = byPage.get(c.account.externalId) || [];
    list.push(c);
    byPage.set(c.account.externalId, list);
  }

  for (const [pageId, comments] of byPage) {
    const client = await createMetaClient(pageId);
    if (!client) continue;

    for (const comment of comments) {
      stats.checked++;
      try {
        const fresh = await client.getComment(comment.externalId);
        const name = fresh?.from?.name;
        if (name) {
          await prisma.socialComment.update({
            where: { id: comment.id },
            data: {
              authorId: fresh.from?.id || comment.authorId,
              authorName: name,
              authorProfileUrl:
                fresh.from?.picture?.url ||
                fresh.from?.picture?.data?.url ||
                comment.authorProfileUrl,
            },
          });
          stats.updated++;
        } else {
          stats.stillUnknown++;
          // Mark so we don't re-check forever (profile deleted/unavailable)
          await prisma.socialComment.update({
            where: { id: comment.id },
            data: { authorName: 'Facebook user' },
          });
        }
      } catch (err) {
        stats.stillUnknown++;
        const message = err instanceof Error ? err.message : String(err);
        // Code 100 "does not exist" means the comment was removed on Facebook
        // (author deleted it or blocked the page) - mark it deleted so it
        // leaves the UI and never burns Meta quota on retries again
        if (message.includes('(code: 100)')) {
          await prisma.socialComment
            .update({
              where: { id: comment.id },
              data: { deleted: true },
            })
            .catch(() => undefined);
        } else {
          console.error(
            `[AuthorBackfill] Failed for comment ${comment.externalId}:`,
            message
          );
          // Leave as Unknown; transient errors retry on a later pass
        }
      }
    }
  }

  return stats;
}
