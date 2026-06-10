/**
 * Low-star review draft pipeline
 * Scans recent Judge.me reviews; every review rated 3 stars or less that has
 * no store reply gets a pre-written public response (ReviewDraft) so the VA
 * just reviews and publishes from the tool.
 */

import Anthropic from '@anthropic-ai/sdk';
import prisma from '@/lib/db';
import { getClaudeConfig } from '@/lib/claude';
import { createJudgemeClient, type JudgemeReview } from '@/lib/judgeme/client';

const REVIEW_DRAFT_MODEL = process.env.REVIEW_DRAFT_MODEL || 'claude-opus-4-8';
/** How many recent reviews to scan per pass */
const SCAN_PER_PAGE = 24;
const SCAN_PAGES = 2;

const SYSTEM_PROMPT = `You write public replies to negative product reviews for Summit Soul (summitsoul.shop), a small made-to-order nature apparel brand run by Pati. Replies are PUBLIC on the product page, so every prospective customer will read them.

Rules:
- Warm, human, professional. No slang, no excuses, no defensiveness, no corporate boilerplate.
- 2-4 short sentences. Thank them for the honest feedback, acknowledge the specific issue they raised, and offer to make it right.
- Always invite them to email support@summitsoul.shop so we can resolve it personally (replacement, refund, or whatever fits).
- Never promise a specific refund/replacement in public - that gets handled over email.
- Never blame the customer, the carrier, or the print provider.
- NEVER use em dashes. Plain hyphens only.
- Output ONLY the reply text, no quotes, no commentary.`;

export interface ReviewDraftStats {
  scanned: number;
  drafted: number;
  failed: number;
}

async function generateReplyDraft(review: JudgemeReview): Promise<string> {
  const config = await getClaudeConfig();
  if (!config) throw new Error('Claude integration not configured');

  const client = new Anthropic({ apiKey: config.apiKey });

  const userMessage =
    `Product: ${review.product?.title || 'Unknown product'}\n` +
    `Rating: ${review.rating}/5\n` +
    `Reviewer: ${review.reviewer?.name || 'Customer'}\n` +
    `Review title: ${review.title || '(none)'}\n` +
    `Review:\n${review.body || '(no text)'}\n\n` +
    `Write the public store reply.`;

  const response = await client.messages.create({
    model: REVIEW_DRAFT_MODEL,
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content.find((c) => c.type === 'text');
  if (!text || text.type !== 'text') throw new Error('No text in response');
  return text.text.trim().replace(/\s*[—–]\s*/g, ' - ');
}

/**
 * One pass: scan recent reviews, draft replies for unanswered <=3-star ones.
 */
export async function runReviewDraftPass(): Promise<ReviewDraftStats> {
  const stats: ReviewDraftStats = { scanned: 0, drafted: 0, failed: 0 };

  const judgeme = await createJudgemeClient();
  if (!judgeme) return stats;

  const reviews: JudgemeReview[] = [];
  for (let page = 1; page <= SCAN_PAGES; page++) {
    const result = await judgeme.getRecentReviews(page, SCAN_PER_PAGE);
    reviews.push(...result.reviews);
    if (page >= result.totalPages) break;
  }
  stats.scanned = reviews.length;

  for (const review of reviews) {
    if (review.rating > 3) continue;
    if (review.replied) {
      // Already answered - make sure any draft is retired
      await prisma.reviewDraft
        .updateMany({
          where: { reviewId: review.id, status: { not: 'HANDLED' } },
          data: { status: 'HANDLED' },
        })
        .catch(() => undefined);
      continue;
    }
    if (review.curated === 'spam') continue; // hidden - nothing to answer publicly

    const existing = await prisma.reviewDraft.findUnique({
      where: { reviewId: review.id },
    });
    if (existing && existing.status !== 'FAILED') continue;

    try {
      const body = await generateReplyDraft(review);
      await prisma.reviewDraft.upsert({
        where: { reviewId: review.id },
        create: {
          reviewId: review.id,
          rating: review.rating,
          reviewerName: review.reviewer?.name || null,
          reviewTitle: review.title || null,
          reviewBody: review.body || null,
          productTitle: review.product?.title || null,
          reviewCreatedAt: review.createdAt ? new Date(review.createdAt) : null,
          body,
          status: 'READY',
          model: REVIEW_DRAFT_MODEL,
        },
        update: { body, status: 'READY', model: REVIEW_DRAFT_MODEL, error: null },
      });
      stats.drafted++;
    } catch (err) {
      stats.failed++;
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[ReviewDrafts] Failed for review ${review.id}:`, message);
      await prisma.reviewDraft
        .upsert({
          where: { reviewId: review.id },
          create: {
            reviewId: review.id,
            rating: review.rating,
            reviewerName: review.reviewer?.name || null,
            reviewTitle: review.title || null,
            reviewBody: review.body || null,
            productTitle: review.product?.title || null,
            reviewCreatedAt: review.createdAt ? new Date(review.createdAt) : null,
            body: '',
            status: 'FAILED',
            error: message,
          },
          update: { status: 'FAILED', error: message },
        })
        .catch(() => undefined);
    }
  }

  return stats;
}

/** Mark a review's draft as handled (after reply or hide). */
export async function markReviewHandled(reviewId: number): Promise<void> {
  await prisma.reviewDraft
    .updateMany({
      where: { reviewId },
      data: { status: 'HANDLED' },
    })
    .catch(() => undefined);
}
