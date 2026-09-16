/**
 * The two customer channels that are NOT the support inbox: comments on
 * Facebook and Instagram, and Judge.me reviews.
 *
 * The daily report is built from email and says so. Pati still wants to see
 * these two counts beside it (2026-09-16), because the inbox is only a third
 * of what customers say to her in a day and a quiet inbox next to a loud
 * comment thread is a misleading picture.
 *
 * Counts only. Nothing here is classified, attributed to a design, or fed to
 * the pattern alarm - those run on email rows and stay that way.
 *
 * Both readers return null rather than zero when they cannot read. That
 * distinction is the whole reason this report exists: a real zero and a broken
 * integration look identical as a number, and this report replaced a daily
 * message that stopped arriving without anyone noticing. "Could not read" is a
 * fine thing to print; a false zero is not.
 */

import prisma from '@/lib/db';
import { createJudgemeClient } from '@/lib/judgeme/client';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Days the "normal for this" average is measured over - same as the email. */
const BASELINE_DAYS = 7;
/** Pages of reviews to walk before giving up and calling the count a floor. */
const REVIEW_MAX_PAGES = 4;
const REVIEW_PER_PAGE = 50;
/** At or below this many stars, a review is something to go and read. */
const LOW_STAR = 3;

export interface SocialCounts {
  /** Comments from customers in the window - never our own replies. */
  comments: number;
  complaints: number;
  questions: number;
  /**
   * Comments still sitting at NEW over the baseline window - nobody has looked
   * at them. NEW means unreviewed, not unanswered: the two other statuses
   * (IN_PROGRESS, ESCALATED) are unused on this account, so in practice every
   * comment is either NEW or DONE.
   */
  unreviewed: number;
  /** Daily average over the previous BASELINE_DAYS, so the count can be read. */
  average: number;
}

export interface ReviewCounts {
  total: number;
  lowStar: number;
  avgRating: number;
  /** True when the page cap was hit, so `total` is a floor and not the count. */
  capped: boolean;
}

/**
 * Comments customers left in the window.
 *
 * `isPageOwner` excludes our own replies, and deleted ones are gone. Note that
 * the great majority of these sit on ADS rather than posts - 8,951 ad comments
 * against 127 post comments in the store's history - so the raw number is
 * mostly ad chatter and tags. The complaint and question splits are the part
 * worth acting on, which is why they are pulled out rather than left inside
 * the total.
 */
export async function socialCounts(now = new Date()): Promise<SocialCounts | null> {
  const since = new Date(now.getTime() - DAY_MS);
  const baselineStart = new Date(since.getTime() - BASELINE_DAYS * DAY_MS);
  const fromCustomer = { isPageOwner: false, deleted: false };

  try {
    const [comments, complaints, questions, unreviewed, baseline] = await Promise.all([
      prisma.socialComment.count({
        where: { ...fromCustomer, commentedAt: { gte: since, lte: now } },
      }),
      prisma.socialComment.count({
        where: {
          ...fromCustomer,
          category: 'COMPLAINT',
          commentedAt: { gte: since, lte: now },
        },
      }),
      prisma.socialComment.count({
        where: {
          ...fromCustomer,
          category: 'QUESTION',
          commentedAt: { gte: since, lte: now },
        },
      }),
      prisma.socialComment.count({
        where: { ...fromCustomer, status: 'NEW', commentedAt: { gte: baselineStart } },
      }),
      prisma.socialComment.count({
        where: { ...fromCustomer, commentedAt: { gte: baselineStart, lt: since } },
      }),
    ]);

    return {
      comments,
      complaints,
      questions,
      unreviewed,
      average: baseline / BASELINE_DAYS,
    };
  } catch (err) {
    console.error('[issue-report] social counts failed:', err);
    return null;
  }
}

/**
 * Reviews left in the window, with the low-star count called out.
 *
 * Judge.me has no "since" filter, so this walks the newest reviews until it
 * passes the cutoff. Four pages of fifty is far more than a day has ever
 * produced here; if it ever is not, `capped` says so rather than quietly
 * reporting a number that is really a page limit.
 */
export async function reviewCounts(now = new Date()): Promise<ReviewCounts | null> {
  const since = new Date(now.getTime() - DAY_MS);

  try {
    const judgeme = await createJudgemeClient();
    if (!judgeme) return null;

    let total = 0;
    let lowStar = 0;
    let ratingSum = 0;
    let capped = false;

    // Paging copied from the review drafter, which has been walking this same
    // endpoint successfully for months. It stops on a SHORT page rather than
    // on `totalPages`, and that is deliberate: totalPages is passed straight
    // through from Judge.me's response, so if the endpoint ever omits it the
    // comparison is `page >= undefined`, which is false forever. That would
    // burn four calls a day and, worse, trip the cap flag on a quiet day and
    // print "6+ reviews" when the honest answer is 6.
    for (let page = 1; page <= REVIEW_MAX_PAGES; page++) {
      const result = await judgeme.getRecentReviews(page, REVIEW_PER_PAGE);
      if (result.reviews.length === 0) break;

      let reachedOlder = false;
      for (const r of result.reviews) {
        if (new Date(r.createdAt) < since) {
          reachedOlder = true;
          continue;
        }
        total++;
        ratingSum += r.rating;
        if (r.rating <= LOW_STAR) lowStar++;
      }

      // Reviews come newest first, so a page that reaches past the cutoff - or
      // a short final page - means there is nothing older left worth walking.
      if (reachedOlder || result.reviews.length < REVIEW_PER_PAGE) break;
      // A full page, all of it inside the window, and no pages left to look
      // at: the total is a floor, and the line has to say so.
      if (page === REVIEW_MAX_PAGES) capped = true;
    }

    return {
      total,
      lowStar,
      avgRating: total ? ratingSum / total : 0,
      capped,
    };
  } catch (err) {
    console.error('[issue-report] review counts failed:', err);
    return null;
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The Slack lines for both channels. Returns one line each, always - a source
 * that could not be read says so out loud instead of vanishing.
 */
export function channelLines(
  social: SocialCounts | null,
  reviews: ReviewCounts | null
): string[] {
  const lines: string[] = [];

  if (!social) {
    lines.push(`Social comments: could not read them today`);
  } else {
    const parts: string[] = [];
    if (social.complaints) parts.push(plural(social.complaints, 'complaint'));
    if (social.questions) parts.push(plural(social.questions, 'question'));
    if (social.unreviewed) {
      parts.push(`${social.unreviewed} not looked at this week`);
    }
    lines.push(
      `Social comments: ${social.comments}` +
        ` (normally ${social.average.toFixed(0)}/day)` +
        (parts.length ? ` - ${parts.join(', ')}` : '')
    );
  }

  if (!reviews) {
    lines.push(`Reviews: could not read them today`);
  } else if (reviews.total === 0) {
    lines.push(`Reviews: none today`);
  } else {
    lines.push(
      `Reviews: ${reviews.total}${reviews.capped ? '+' : ''}` +
        `, ${reviews.avgRating.toFixed(1)} stars average` +
        (reviews.lowStar
          ? ` - ${plural(reviews.lowStar, 'review')} at ${LOW_STAR} stars or below`
          : '')
    );
  }

  return lines;
}
