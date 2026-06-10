/**
 * Background worker entrypoint (Railway service)
 *
 * Independent loops, each with an overlap guard:
 *  - email sync        every 90s   (kills the manual "Sync" wait)
 *  - AI triage/drafts  every 20s   (classify + pre-generate reply drafts)
 *  - Printify sync     every 10min (order/production status cache)
 *  - tracking refresh  every 30min (warm carrier status for open threads)
 *
 * Run with: npm run worker  (tsx resolves the @/ path alias natively)
 */

import prisma from '@/lib/db';
import { runEmailSync } from '@/lib/email/sync-service';
import { syncPrintifyOrders } from '@/lib/printify/sync';
import {
  processPendingRelinks,
  ensurePrintifyWebhooks,
} from '@/lib/printify/relink';
import { refreshTrackingForOpenThreads } from '@/lib/trackingmore/refresh';
import { refreshShopifyKnowledge } from '@/lib/knowledge/refresh';
import { runReviewDraftPass } from '@/lib/judgeme/review-drafts';
import { syncAllSocialAccounts, autoResolveComments } from '@/lib/social/sync';
import { runCommentDraftPass } from '@/lib/social/comment-drafts';
import { backfillCommentAuthors } from '@/lib/social/backfill-authors';
import { syncMessengerAndDraft } from '@/lib/social/messenger';
import { runTriagePass } from '@/lib/ai/pipeline';

const EMAIL_SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL || '90000', 10);
const TRIAGE_INTERVAL = parseInt(process.env.TRIAGE_INTERVAL || '20000', 10);
const PRINTIFY_SYNC_INTERVAL = parseInt(
  process.env.PRINTIFY_SYNC_INTERVAL || `${10 * 60 * 1000}`,
  10
);
const TRACKING_REFRESH_INTERVAL = parseInt(
  process.env.TRACKING_REFRESH_INTERVAL || `${30 * 60 * 1000}`,
  10
);
const RELINK_POLL_INTERVAL = parseInt(
  process.env.RELINK_POLL_INTERVAL || `${15 * 60 * 1000}`,
  10
);
const KNOWLEDGE_REFRESH_INTERVAL = parseInt(
  process.env.KNOWLEDGE_REFRESH_INTERVAL || `${6 * 60 * 60 * 1000}`,
  10
);
const REVIEW_DRAFT_INTERVAL = parseInt(
  process.env.REVIEW_DRAFT_INTERVAL || `${20 * 60 * 1000}`,
  10
);
const SOCIAL_SYNC_INTERVAL = parseInt(
  process.env.SOCIAL_SYNC_INTERVAL || `${5 * 60 * 1000}`,
  10
);
const COMMENT_DRAFT_INTERVAL = parseInt(
  process.env.COMMENT_DRAFT_INTERVAL || `${2 * 60 * 1000}`,
  10
);
const MESSENGER_SYNC_INTERVAL = parseInt(
  process.env.MESSENGER_SYNC_INTERVAL || `${2 * 60 * 1000}`,
  10
);

/**
 * Wrap a job in an overlap guard + error isolation, and schedule it.
 */
function startLoop(
  name: string,
  intervalMs: number,
  job: () => Promise<void>
): NodeJS.Timeout {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await job();
    } catch (err) {
      console.error(`[worker:${name}] error:`, err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };

  // Stagger initial runs slightly so all loops don't hit the DB at once
  setTimeout(tick, Math.floor(Math.random() * 3000));
  return setInterval(tick, intervalMs);
}

async function main() {
  console.log('[worker] Starting Support Desk background worker');
  console.log(
    `[worker] intervals: email=${EMAIL_SYNC_INTERVAL}ms triage=${TRIAGE_INTERVAL}ms ` +
      `printify=${PRINTIFY_SYNC_INTERVAL}ms tracking=${TRACKING_REFRESH_INTERVAL}ms`
  );

  const timers: NodeJS.Timeout[] = [];

  timers.push(
    startLoop('email-sync', EMAIL_SYNC_INTERVAL, async () => {
      const outcome = await runEmailSync();
      if (outcome.skipped) return;
      if (!outcome.success) {
        console.error('[worker:email-sync] failed:', outcome.error);
        return;
      }
      if (outcome.messagesProcessed > 0) {
        console.log(
          `[worker:email-sync] ${outcome.messagesProcessed} new messages, ` +
            `${outcome.newInboundThreadIds.length} threads need drafts`
        );
      }
    })
  );

  timers.push(
    startLoop('triage', TRIAGE_INTERVAL, async () => {
      const stats = await runTriagePass(5);
      if (stats.scanned > 0) {
        console.log(
          `[worker:triage] processed=${stats.processed} failed=${stats.failed}`
        );
      }
    })
  );

  timers.push(
    startLoop('printify-sync', PRINTIFY_SYNC_INTERVAL, async () => {
      const stats = await syncPrintifyOrders({});
      console.log(`[worker:printify-sync]`, JSON.stringify(stats));
    })
  );

  timers.push(
    startLoop('tracking-refresh', TRACKING_REFRESH_INTERVAL, async () => {
      const stats = await refreshTrackingForOpenThreads();
      if (stats.candidates > 0) {
        console.log(
          `[worker:tracking-refresh] refreshed=${stats.refreshed} errors=${stats.errors}`
        );
      }
    })
  );

  // Register Printify webhooks once, retrying on each poll tick until it
  // succeeds (so a boot-time DB blip can't permanently skip registration).
  let webhooksRegistered = false;
  timers.push(
    startLoop('relink-poll', RELINK_POLL_INTERVAL, async () => {
      if (!webhooksRegistered) {
        try {
          await ensurePrintifyWebhooks();
          webhooksRegistered = true;
        } catch (err) {
          console.error('[worker] webhook registration retry failed:', err);
        }
      }
      const stats = await processPendingRelinks();
      if (stats.checked > 0) {
        console.log(
          `[worker:relink-poll] checked=${stats.checked} pushed=${stats.pushed} failed=${stats.failed}`
        );
      }
    })
  );

  timers.push(
    startLoop('social-sync', SOCIAL_SYNC_INTERVAL, async () => {
      const results = await syncAllSocialAccounts();
      for (const [name, s] of results) {
        if (s.newComments > 0) {
          console.log(`[worker:social-sync] ${name}: ${s.newComments} new comments`);
        }
      }

      // Fill in author names for comments synced while the app was in
      // dev mode (Meta withheld them); no-op once none remain.
      const backfill = await backfillCommentAuthors();
      if (backfill.checked > 0) {
        console.log(
          `[worker:social-sync] author backfill: updated=${backfill.updated} stillUnknown=${backfill.stillUnknown}`
        );
      }

      // Close out comments already liked/replied (anywhere) or older than 14d
      const resolved = await autoResolveComments();
      if (resolved > 0) {
        console.log(`[worker:social-sync] auto-resolved ${resolved} handled/stale comments`);
      }
    })
  );

  timers.push(
    startLoop('messenger-sync', MESSENGER_SYNC_INTERVAL, async () => {
      const stats = await syncMessengerAndDraft();
      if (stats.newMessages > 0 || stats.drafted > 0 || stats.errors > 0) {
        console.log(
          `[worker:messenger-sync] newMessages=${stats.newMessages} drafted=${stats.drafted} errors=${stats.errors}`
        );
      }
    })
  );

  timers.push(
    startLoop('comment-drafts', COMMENT_DRAFT_INTERVAL, async () => {
      const stats = await runCommentDraftPass();
      if (stats.drafted > 0 || stats.failed > 0) {
        console.log(
          `[worker:comment-drafts] drafted=${stats.drafted} failed=${stats.failed}`
        );
      }
    })
  );

  timers.push(
    startLoop('review-drafts', REVIEW_DRAFT_INTERVAL, async () => {
      const stats = await runReviewDraftPass();
      if (stats.drafted > 0 || stats.failed > 0) {
        console.log(
          `[worker:review-drafts] scanned=${stats.scanned} drafted=${stats.drafted} failed=${stats.failed}`
        );
      }
    })
  );

  timers.push(
    startLoop('knowledge-refresh', KNOWLEDGE_REFRESH_INTERVAL, async () => {
      const stats = await refreshShopifyKnowledge();
      if (stats.pages > 0 || stats.policies > 0 || stats.collections > 0 || stats.products > 0) {
        console.log(
          `[worker:knowledge-refresh] pages=${stats.pages} policies=${stats.policies} ` +
            `collections=${stats.collections} products=${stats.products}`
        );
      }
    })
  );

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, shutting down...`);
    for (const timer of timers) clearInterval(timer);
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
