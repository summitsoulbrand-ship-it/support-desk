/**
 * Shared open-work where-clauses - the single definition of "what counts as
 * an open item" per queue, used by BOTH the list routes (what the page shows)
 * and the nav badge counts (what the sidebar counts). Keeping them here stops
 * the badge and the page from drifting apart. Change a queue's definition in
 * this file, never in just one of the two places that read it.
 */

import type { Prisma } from '@prisma/client';

/**
 * Facebook auto-opens a Messenger chat mirroring every ad comment, tagged
 * with a system message starting with this prefix. Those belong in the
 * Comments tab, not the Messages list.
 */
export const FACEBOOK_COMMENT_MIRROR_PREFIX = 'Facebook created this chat';

/**
 * Threads with the "Design" tag live in their own folder (like Trash) and
 * are excluded from the default inbox views.
 */
export function notDesignTaggedWhere(): Prisma.ThreadWhereInput {
  return {
    tags: {
      none: { tag: { name: { equals: 'Design', mode: 'insensitive' } } },
    },
  };
}

/**
 * Email inbox default view: OPEN/PENDING threads, not Design-tagged.
 */
export function openThreadsWhere(): Prisma.ThreadWhereInput {
  return {
    status: { in: ['OPEN', 'PENDING'] },
    ...notDesignTaggedWhere(),
  };
}

/**
 * Invariants of the social Comments list: top-level comments only (not
 * replies), never the page's own comments, never deleted ones.
 */
export function socialCommentsBaseWhere(): Prisma.SocialCommentWhereInput {
  return { parentId: null, isPageOwner: false, deleted: false };
}

/**
 * Social page "Comments" open tab: NEW/IN_PROGRESS/ESCALATED top-level
 * comments.
 */
export function openSocialCommentsWhere(): Prisma.SocialCommentWhereInput {
  return {
    ...socialCommentsBaseWhere(),
    status: { in: ['NEW', 'IN_PROGRESS', 'ESCALATED'] },
  };
}

/**
 * Social page "Messages" tab: real DMs only (no Facebook comment-mirror
 * chats), anything not DONE.
 */
export function openSocialConversationsWhere(): Prisma.SocialConversationWhereInput {
  return {
    status: { not: 'DONE' },
    messages: {
      none: {
        message: {
          startsWith: FACEBOOK_COMMENT_MIRROR_PREFIX,
          mode: 'insensitive',
        },
      },
    },
  };
}

/**
 * Reviews needing attention: pre-written reply drafts awaiting review,
 * still generating, or failed.
 */
export function reviewsAttentionWhere(): Prisma.ReviewDraftWhereInput {
  return { status: { in: ['READY', 'PENDING', 'FAILED'] } };
}

/**
 * Manually escalated threads not yet resolved (Needs Attention tab).
 */
export function manualAttentionWhere(): Prisma.ThreadWhereInput {
  return { needsManual: true, manualResolvedAt: null };
}

/**
 * Failed AI drafts on threads that are still actionable (Needs Attention
 * tab skips drafts whose thread is already closed/trashed).
 */
export function failedDraftsWhere(): Prisma.AiDraftWhereInput {
  return {
    status: 'FAILED',
    thread: { status: { in: ['OPEN', 'PENDING'] } },
  };
}

/**
 * Printify relinks that failed to push fulfillment back (Needs Attention tab).
 */
export function failedRelinksWhere(): Prisma.OrderRelinkWhereInput {
  return { status: 'FAILED' };
}

/**
 * Printify escalations the operator still needs to action (Needs Attention tab).
 */
export function pendingEscalationsWhere(): Prisma.PrintifyEscalationWhereInput {
  return { status: 'PENDING' };
}
