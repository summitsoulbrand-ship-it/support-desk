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
      category: 'TAG',
      isLikedByPage: false,
    };

    const batch = await prisma.socialComment.findMany({
      where,
      orderBy: { commentedAt: 'desc' },
      take: BATCH,
      include: { account: { select: { externalId: true } } },
    });

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

    const remaining = await prisma.socialComment.count({ where });

    return NextResponse.json({ liked, failed, remaining });
  } catch (err) {
    console.error('Bulk like failed:', err);
    return NextResponse.json({ error: 'Bulk like failed' }, { status: 500 });
  }
}
