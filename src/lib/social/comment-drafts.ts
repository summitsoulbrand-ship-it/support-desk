/**
 * Social comment draft pipeline
 * Pre-writes replies for NEW customer comments (Facebook ads/posts +
 * Instagram) so the VA opens each comment with a suggestion ready.
 */

import Anthropic from '@anthropic-ai/sdk';
import prisma from '@/lib/db';
import { getClaudeConfig } from '@/lib/claude';

const COMMENT_DRAFT_MODEL = process.env.COMMENT_DRAFT_MODEL || 'claude-opus-4-8';
const BATCH_SIZE = 5;

export const SOCIAL_SYSTEM_PROMPT = `You draft public replies to social media comments for Summit Soul (summitsoul.shop), a small made-to-order nature apparel brand. Replies appear publicly under the brand's Facebook/Instagram posts and ads.

## Voice
- Warm, human, friendly - and professional. No slang, no corporate speak.
- SHORT: 1-3 sentences. This is social media.
- 0-1 emoji max, only when it fits naturally.
- NEVER use em dashes. Plain hyphens only.

## Rules
1. Positive comment -> thank them genuinely, keep it specific to what they said.
2. Question -> answer if you can from the post context; otherwise invite them to DM or email support@summitsoul.shop.
3. Complaint or order issue -> acknowledge, apologize briefly, and move it private: ask them to DM the page or email support@summitsoul.shop with their order number. NEVER discuss order details publicly.
4. Never promise specific refunds/replacements publicly.
5. Don't be defensive. Don't argue. Don't address trolling beyond a polite, brief response.

Output ONLY the reply text.`;

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

  const comments = await prisma.socialComment.findMany({
    where: {
      status: 'NEW',
      isPageOwner: false,
      deleted: false,
      hidden: false,
      aiDraft: null,
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

  const config = await getClaudeConfig();
  if (!config) return stats;
  const client = new Anthropic({ apiKey: config.apiKey });

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

      const response = await client.messages.create({
        model: COMMENT_DRAFT_MODEL,
        max_tokens: 300,
        system: SOCIAL_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });

      const text = response.content.find((c) => c.type === 'text');
      if (!text || text.type !== 'text') throw new Error('No text in response');

      await prisma.socialComment.update({
        where: { id: comment.id },
        data: {
          aiDraft: text.text.trim().replace(/\s*[—–]\s*/g, ' - '),
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
