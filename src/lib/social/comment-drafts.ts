/**
 * Social comment draft pipeline
 * Pre-writes replies for NEW customer comments (Facebook ads/posts +
 * Instagram) so the VA opens each comment with a suggestion ready.
 */

import Anthropic from '@anthropic-ai/sdk';
import prisma from '@/lib/db';
import { getSocialKnowledgeText } from './knowledge';
import { getClaudeConfig } from '@/lib/claude';
import {
  COMPANY_IDENTITY,
  BRAND_VOICE_GUIDELINES,
  STORE_POLICY_FACTS,
  withOperatorInstructions,
} from '@/lib/claude/brand-voice';

const COMMENT_DRAFT_MODEL = process.env.COMMENT_DRAFT_MODEL || 'claude-opus-4-8';
const BATCH_SIZE = 5;

export const SOCIAL_SYSTEM_PROMPT = `You are the customer service voice of Summit Soul. ${COMPANY_IDENTITY} You draft PUBLIC replies to Facebook and Instagram comments and ads. They appear publicly under the brand's posts, so they represent the company - use the brand's customer service voice, but you can show a little more of the brand's playful side here since this is public social.

${BRAND_VOICE_GUIDELINES}

${STORE_POLICY_FACTS}

## Social format (this channel only)
- SHORT: 1-3 sentences. A public comment, not an email - no greeting line, no signature.
- 0-1 emoji max, only when it genuinely fits. Never use an emoji to soften a complaint.

## Rules
1. Positive comment -> thank them genuinely and specifically to what they said.
2. Question -> answer if you can from the post/product context; otherwise invite them to send a direct message or email support@summitsoul.shop.
3. Complaint or order issue -> apologize briefly and sincerely, then move it private: ask them to send a direct message or email support@summitsoul.shop with their order number. NEVER discuss order details, tracking, or personal info publicly.
4. Never promise a specific refund, replacement, or outcome publicly.
5. Dismissive, troll, or low-effort jab comments (name-calling, "this is dumb/stupid/lame", a spaced-out slur, "lol no") that are NOT a genuine complaint: keep it LIGHT and friendly, not serious or corporate. Do NOT get defensive, argue, or over-explain, and never repeat or engage the insult or slur itself. Reply with ONE short, good-natured, lightly playful line that stays warm and on-brand - the goal is to disarm with charm and win over everyone else reading, not to snark back. A confident, friendly, slightly witty deflection beats a flat "thanks for stopping by." Never match the negativity and never insult back.
6. On any comment: don't be defensive and don't argue - stay calm and brief.

Output ONLY the reply text - no internal notes or formatting.`;

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
        system:
          withOperatorInstructions(SOCIAL_SYSTEM_PROMPT, config.customPrompt) +
          (await getSocialKnowledgeText()),
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
