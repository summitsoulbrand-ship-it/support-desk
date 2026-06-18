/**
 * Low-star review draft pipeline
 * Scans recent Judge.me reviews; every review rated 3 stars or less that has
 * no store reply gets a pre-written public response (ReviewDraft) so the VA
 * just reviews and publishes from the tool.
 */

import Anthropic from '@anthropic-ai/sdk';
import prisma from '@/lib/db';
import { getClaudeConfig } from '@/lib/claude';
import {
  COMPANY_IDENTITY,
  BRAND_VOICE_GUIDELINES,
  STORE_POLICY_FACTS,
  withOperatorInstructions,
} from '@/lib/claude/brand-voice';
import { createJudgemeClient, type JudgemeReview } from '@/lib/judgeme/client';

const REVIEW_DRAFT_MODEL = process.env.REVIEW_DRAFT_MODEL || 'claude-opus-4-8';
/**
 * We scan by RATING (1, 2, 3) using the Judge.me rating filter, instead of
 * just reading the N most-recent reviews. A burst of 5-star reviews used to
 * bury a low-star one past the recent-window before the scan ran, so it was
 * never drafted. Filtering by rating means low-star reviews can never be
 * crowded out. Reviews are returned newest-first, so we page until we either
 * run out or cross the recency cutoff.
 */
const LOW_RATINGS = [1, 2, 3];
const SCAN_PER_PAGE = 50;
const MAX_PAGES_PER_RATING = 6; // 6 * 50 = 300 per rating - ample within the window
const RECENCY_DAYS = 180; // do not draft replies to reviews older than this
const DAY_MS = 24 * 60 * 60 * 1000;

const SYSTEM_PROMPT = `You are the customer service voice of Summit Soul. ${COMPANY_IDENTITY} You write PUBLIC replies to negative product reviews on the product page, so every prospective customer will read them. Use the exact same voice as the brand's customer service emails.

${BRAND_VOICE_GUIDELINES}

${STORE_POLICY_FACTS}

## Review reply format (this channel only)
- 2-4 short sentences. Thank them for the honest feedback, acknowledge the specific issue they raised, and offer to make it right.
- Always invite them to email support@summitsoul.shop so we can resolve it personally (replacement, refund, or whatever fits).
- Never promise a specific refund/replacement in public - that gets handled over email.
- Never blame the customer, the carrier, or the print provider.
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
    system: withOperatorInstructions(SYSTEM_PROMPT, config.customPrompt),
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

  const cutoff = Date.now() - RECENCY_DAYS * DAY_MS;
  const byId = new Map<number, JudgemeReview>();
  for (const rating of LOW_RATINGS) {
    for (let page = 1; page <= MAX_PAGES_PER_RATING; page++) {
      const result = await judgeme.getRecentReviews(page, SCAN_PER_PAGE, rating);
      if (result.reviews.length === 0) break;
      let crossedCutoff = false;
      for (const review of result.reviews) {
        const ts = review.createdAt ? new Date(review.createdAt).getTime() : Date.now();
        if (ts < cutoff) {
          crossedCutoff = true;
          continue;
        }
        byId.set(review.id, review);
      }
      // Reviews come newest-first, so once a page is entirely older than the
      // cutoff (or it's a short final page) there is nothing more to scan.
      if (crossedCutoff || result.reviews.length < SCAN_PER_PAGE) break;
    }
  }
  const reviews = [...byId.values()];
  stats.scanned = reviews.length;

  for (const review of reviews) {
    if (review.rating > 3) continue;
    // Loox reviews were imported from another app and are read-only in Judge.me
    // - we can never post a reply via the API, so do not draft one (no dead
    // buttons, no wasted AI cost). Pati no longer uses Loox, so this is a
    // permanent skip. Retire any existing draft for one.
    if (review.source === 'loox') {
      await prisma.reviewDraft
        .updateMany({
          where: { reviewId: review.id, status: { not: 'HANDLED' } },
          data: { status: 'HANDLED' },
        })
        .catch(() => undefined);
      continue;
    }
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
