/**
 * Social comment draft pipeline
 * Pre-writes replies for NEW customer comments (Facebook ads/posts +
 * Instagram) so the VA opens each comment with a suggestion ready.
 */

import prisma from '@/lib/db';
import { getSocialKnowledgeText } from './knowledge';
import { createClaudeService } from '@/lib/claude';

// Pre-drafts are a convenience the operator reviews before sending, and most
// comments are short/simple, so use cheap Haiku here (≈15x cheaper than Opus).
// The on-demand "Suggest Reply" button stays on the premium model for quality.
const COMMENT_DRAFT_MODEL =
  process.env.COMMENT_DRAFT_MODEL || 'claude-haiku-4-5-20251001';
const BATCH_SIZE = 5;

export interface CommentDraftStats {
  scanned: number;
  drafted: number;
  failed: number;
}

/**
 * One pass: draft replies for NEW, non-page, non-deleted comments that don't
 * have a draft yet. Costs one short Claude call per new comment.
 */
export async function runCommentDraftPass(): Promise<CommentDraftStats> {
  const stats: CommentDraftStats = { scanned: 0, drafted: 0, failed: 0 };

  // Kill switch (set COMMENT_DRAFTS_DISABLED=1) - and even when enabled,
  // only draft RECENT comments: backfills can dump hundreds of old ad
  // comments (mostly tag-a-friend noise) that would burn credits for nothing.
  if (process.env.COMMENT_DRAFTS_DISABLED === '1') return stats;
  const maxAgeDays = parseInt(process.env.COMMENT_DRAFT_MAX_AGE_DAYS || '3', 10);
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

  const comments = await prisma.socialComment.findMany({
    where: {
      status: 'NEW',
      isPageOwner: false,
      deleted: false,
      hidden: false,
      aiDraft: null,
      commentedAt: { gte: cutoff },
      // Friend-tags / sticker-only comments never get a written reply (they're
      // auto-liked / bulk-liked), so don't burn credits drafting one. `not`
      // still includes not-yet-categorized (null) comments.
      category: { not: 'TAG' },
    },
    orderBy: { commentedAt: 'desc' },
    take: BATCH_SIZE,
    include: {
      object: { select: { message: true, type: true } },
      parent: { select: { message: true, authorName: true, isPageOwner: true } },
    },
  });

  stats.scanned = comments.length;
  if (comments.length === 0) return stats;

  // All AI drafting goes through the shared ClaudeService (social channel),
  // so this path gets the same brand-voice prompt, retired-model
  // normalization, and reply cleanup as the on-demand Suggest button.
  const claude = await createClaudeService();
  if (!claude) return stats;
  // The knowledge block is identical across the batch - fetch it once. The
  // service caches the whole system prefix (5-min TTL), so each call only
  // pays for the cached prefix once, not full input tokens every time.
  const knowledgeText = await getSocialKnowledgeText();

  for (const comment of comments) {
    try {
      let userMessage = '';
      if (comment.object?.message) {
        userMessage += `The ${comment.object.type === 'AD' ? 'ad' : 'post'} says:\n"${comment.object.message.slice(0, 600)}"\n\n`;
      }
      if (comment.parent) {
        userMessage += `In reply to ${comment.parent.isPageOwner ? 'our comment' : comment.parent.authorName}: "${comment.parent.message.slice(0, 300)}"\n\n`;
      }
      userMessage += `${comment.authorName} commented:\n"${comment.message.slice(0, 1000)}"\n\nWrite the brand's public reply.`;

      const draft = await claude.generateSocialReply(userMessage, {
        model: COMMENT_DRAFT_MODEL,
        maxTokens: 300,
        knowledgeText,
      });

      await prisma.socialComment.update({
        where: { id: comment.id },
        data: {
          aiDraft: draft,
          aiDraftAt: new Date(),
        },
      });
      stats.drafted++;
    } catch (err) {
      stats.failed++;
      console.error(
        `[CommentDrafts] Failed for comment ${comment.id}:`,
        err instanceof Error ? err.message : err
      );
      // Mark attempted so a persistent failure doesn't block the batch forever
      await prisma.socialComment
        .update({
          where: { id: comment.id },
          data: { aiDraft: '', aiDraftAt: new Date() },
        })
        .catch(() => undefined);
    }
  }

  return stats;
}
