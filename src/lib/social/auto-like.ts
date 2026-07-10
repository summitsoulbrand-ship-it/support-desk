/**
 * Background auto-like sweep for social comments.
 *
 * Likes (and closes) comments that are positive / friend-tags / clearly need
 * no reply - acknowledging them without a reply. Runs server-side, off the
 * browser, so it never blocks the operator's email work. It is rate-limit
 * aware: it watches Meta's published usage headers and stops the moment we
 * get close to a throttle, and a genuine throttle leaves the comment NEW for
 * the next run instead of silently marking it handled.
 *
 * Instagram has no like-a-comment API, so positive/tag IG comments are
 * acknowledged by closing them (Pati's call).
 */

import prisma from '@/lib/db';
import { createMetaClient, getMetaUsagePercent } from './meta-client';

/**
 * Like-worthy without a reply: pure friend tags, tag+share comments, and
 * clearly positive enthusiasm. Anything questioning or negative is skipped -
 * a brand like on a grumble reads tone-deaf. Shared with the manual bulk-like
 * route so both paths agree on what is safe to like.
 */
export function isLikeable(category: string | null, message: string): boolean {
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

export interface AutoLikeOptions {
  /** Hard cap on comments processed in one run (keeps each pass bounded). */
  maxTotal?: number;
  /** Delay between Facebook like calls (gentle pacing). */
  spacingMs?: number;
  /** Stop when Meta's reported usage % reaches this (leave headroom). */
  usageCeiling?: number;
}

export type AutoLikeStop = 'done' | 'rate_limit' | 'usage_ceiling' | 'cap';

export interface AutoLikeResult {
  liked: number;
  closed: number;
  failed: number;
  remaining: number;
  stoppedReason: AutoLikeStop;
}

export async function autoLikeComments(
  opts: AutoLikeOptions = {}
): Promise<AutoLikeResult> {
  const maxTotal = opts.maxTotal ?? 60;
  const spacingMs = opts.spacingMs ?? 200;
  const usageCeiling = opts.usageCeiling ?? 75;

  const candidates = await prisma.socialComment.findMany({
    where: {
      status: 'NEW',
      isPageOwner: false,
      deleted: false,
      hidden: false,
      parentId: null,
      platform: { in: ['FACEBOOK', 'INSTAGRAM'] },
      category: { in: ['TAG', 'OTHER'] },
      isLikedByPage: false,
    },
    orderBy: { commentedAt: 'desc' },
    take: 500,
    include: { account: { select: { externalId: true } } },
  });
  // Meta MENTION objects (externalId "mention_...") cannot be liked or
  // replied to via the Graph API (code 100/subcode 33) - close them straight
  // away, same treatment as Instagram comments, instead of burning an API
  // call per sweep on a guaranteed error (2026-07-10).
  const mentionIds = candidates
    .filter((c) => c.externalId.startsWith('mention_') && isLikeable(c.category, c.message))
    .map((c) => c.id);
  if (mentionIds.length > 0) {
    await prisma.socialComment.updateMany({
      where: { id: { in: mentionIds } },
      data: { status: 'DONE' },
    });
  }
  const likeable = candidates.filter(
    (c) => !c.externalId.startsWith('mention_') && isLikeable(c.category, c.message)
  );

  let liked = 0;
  let closed = 0;
  let failed = 0;
  let processed = 0;
  let stoppedReason: AutoLikeStop = 'done';
  const clients = new Map<
    string,
    Awaited<ReturnType<typeof createMetaClient>>
  >();

  for (const comment of likeable) {
    if (processed >= maxTotal) {
      stoppedReason = 'cap';
      break;
    }

    // Instagram comments can't be liked through the API - acknowledge by
    // closing them. No Meta write, so no rate-limit concern.
    if (comment.platform !== 'FACEBOOK') {
      await prisma.socialComment.update({
        where: { id: comment.id },
        data: { status: 'DONE' },
      });
      closed++;
      processed++;
      continue;
    }

    // Back off BEFORE the call if Meta says we're near the ceiling.
    if (getMetaUsagePercent() >= usageCeiling) {
      stoppedReason = 'usage_ceiling';
      break;
    }

    let client = clients.get(comment.account.externalId);
    if (client === undefined) {
      client = await createMetaClient(comment.account.externalId);
      clients.set(comment.account.externalId, client);
    }
    if (!client) {
      failed++;
      processed++;
      continue;
    }

    const result = await client.likeComment(comment.externalId);
    if (result.success) {
      await prisma.socialComment.update({
        where: { id: comment.id },
        data: { isLikedByPage: true, status: 'DONE' },
      });
      liked++;
    } else if (result.rateLimited) {
      // Throttled: STOP the whole run and leave this comment NEW so it is
      // retried next time. Never mark a rate-limited comment as handled.
      stoppedReason = 'rate_limit';
      break;
    } else {
      // Genuinely unlikeable (deleted author, gone, etc.) - close it so the
      // sweep terminates instead of retrying the same comment forever.
      await prisma.socialComment.update({
        where: { id: comment.id },
        data: { status: 'DONE' },
      });
      failed++;
    }
    processed++;
    await wait(spacingMs);
  }

  const remaining = Math.max(0, likeable.length - liked - closed - failed);
  return { liked, closed, failed, remaining, stoppedReason };
}
