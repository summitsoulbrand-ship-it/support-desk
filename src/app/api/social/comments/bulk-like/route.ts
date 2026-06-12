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

// Small batches: the whole batch must finish well inside proxy timeouts
const BATCH = 10;
const SPACING_MS = 150;

/**
 * Like-worthy without a reply: pure friend tags, tag+share comments, and
 * clearly positive enthusiasm. Anything questioning or negative is skipped -
 * a brand like on a grumble reads tone-deaf.
 */
function isLikeable(category: string | null, message: string): boolean {
  if (category === 'TAG') return true;
  const t = (message || '').toLowerCase();
  if (!t.trim()) return false;
  if (t.includes('?')) return false;
  if (
    /(pricey|expensive|too much|but |wish |why |not |don'?t|never|can'?t|won'?t|sad|ugly|hate|wrong|bad |smaller|bigger|where|when|how)/.test(t)
  ) {
    return false;
  }
  if (
    /(i (need|want|gotta|love)|love (it|this|these|that|your)|so (cute|cool|awesome|pretty)|awesome|amazing|gorgeous|beautiful|perfect|adorable|haha|lol|cute|great|nice one|yes!|th(an)?x|thank|❤|😍|🤣|😂|👍|🔥)/.test(t)
  ) {
    return true;
  }
  // Tag-plus-text: a name tag with a short shout ("Deb ..too good not to share")
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 10 && /share|look|this is (you|us|me)|need this/.test(t)) return true;
  return false;
}

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

    const where = {
      status: 'NEW' as const,
      isPageOwner: false,
      deleted: false,
      hidden: false,
      parentId: null,
      platform: 'FACEBOOK' as const,
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
    let failed = 0;
    const clients = new Map<string, Awaited<ReturnType<typeof createMetaClient>>>();

    for (const comment of batch) {
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

    const remaining = Math.max(0, likeable.length - batch.length);

    return NextResponse.json({ liked, failed, remaining });
  } catch (err) {
    console.error('Bulk like failed:', err);
    return NextResponse.json({ error: 'Bulk like failed' }, { status: 500 });
  }
}
