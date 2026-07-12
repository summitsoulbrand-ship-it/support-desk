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
import { reconcilePrintifyRecoveries } from '@/lib/printify/recovery';
import { gmailConfigFromEnv } from '@/lib/email/gmail-printify-reader';
import {
  processPendingRelinks,
  ensurePrintifyWebhooks,
} from '@/lib/printify/relink';
import { processPendingItemChanges } from '@/lib/self-service/payment-watch';
import { refreshTrackingForOpenThreads } from '@/lib/trackingmore/refresh';
import { refreshShopifyKnowledge } from '@/lib/knowledge/refresh';
import { runReviewDraftPass } from '@/lib/judgeme/review-drafts';
import { syncAllSocialAccounts, autoResolveComments, categorizeBacklog } from '@/lib/social/sync';
import { autoLikeComments } from '@/lib/social/auto-like';
import { runCommentDraftPass } from '@/lib/social/comment-drafts';
import { backfillCommentAuthors } from '@/lib/social/backfill-authors';
import { syncMessengerAndDraft } from '@/lib/social/messenger';
import { runTriageOnlyPass } from '@/lib/ai/pipeline';
import { sendEscalationDigest } from '@/lib/escalation-digest';
import { runDatabaseBackup, latestBackupAt } from '@/lib/backup';
import {
  runEvalAndEmail,
  EVAL_REQUEST_KEY,
  EVAL_RUNNING_KEY,
  EVAL_RUNNING_TTL_SECONDS,
} from '@/lib/eval/run-draft-eval';
import { cacheGet, cacheSet, cacheDelete, isCacheAvailable } from '@/lib/cache';

/**
 * Read a full-sweep gate stamp, waiting briefly for Redis on a fresh boot.
 * Redis connects lazily a few seconds into the process, but the sweep gates
 * decide on their loop's FIRST tick - trusting a null while Redis was still
 * connecting re-armed both full sweeps on every boot (2026-07-05, the exact
 * storm the stamps exist to prevent). Only after Redis is genuinely reachable
 * (or the grace expires - Redis actually down) does an empty answer mean
 * "no stamp, sweep is due".
 */
async function readGateStamp(key: string, graceMs = 20_000): Promise<number> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const v = await cacheGet<number>(key);
    if (v) return v;
    if (isCacheAvailable() || Date.now() >= deadline) return 0;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
import { runEditDigestAndEmail } from '@/lib/edit-digest';

const EMAIL_SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL || '90000', 10);
// Check every 12h, but the actual eval runs at most weekly (Redis-gated), so it
// survives worker restarts without re-running. Emails the score to the admin.
const EVAL_CHECK_INTERVAL = parseInt(
  process.env.EVAL_CHECK_INTERVAL || `${12 * 60 * 60 * 1000}`,
  10
);
const EVAL_GATE_KEY = 'eval:last-weekly-run';
const EVAL_GATE_SECONDS = 7 * 24 * 60 * 60; // at most once per 7 days

// On-demand eval: the Settings button enqueues a request (Redis); this runs it
// HERE on the worker (long-lived, not killed by web redeploys), persists the
// result, and emails. Checked frequently so the button feels responsive.
const EVAL_REQUEST_POLL_INTERVAL = 60 * 1000;

async function processEvalRequest(): Promise<void> {
  const req = await cacheGet<{ days?: number; limit?: number; toEmail?: string }>(
    EVAL_REQUEST_KEY
  );
  if (!req) return;
  // Claim it: clear the request and mark running. The running flag has a SHORT
  // TTL and is refreshed (heartbeat) on each thread, so if this run dies (e.g. a
  // worker redeploy mid-run) the flag expires in ~2 min and the UI recovers,
  // instead of being stuck for half an hour.
  await cacheDelete(EVAL_REQUEST_KEY);
  const beat = () => cacheSet(EVAL_RUNNING_KEY, Date.now(), EVAL_RUNNING_TTL_SECONDS);
  await beat();
  try {
    const s = await runEvalAndEmail({
      days: req.days,
      limit: req.limit,
      toEmail: req.toEmail,
      onProgress: () => void beat(),
    });
    console.log(
      `[worker:eval-request] evaluated=${s.evaluated} pass=${s.passRatePct}% ` +
        `aq=${s.avg.addressesQuestion} fc=${s.avg.factualConsistency} cm=${s.avg.completeness}`
    );
  } finally {
    await cacheDelete(EVAL_RUNNING_KEY);
  }
}

async function maybeWeeklyEval(): Promise<void> {
  // Set the gate FIRST (7-day TTL) so a restart mid-window can't double-run.
  const recent = await cacheGet<number>(EVAL_GATE_KEY);
  if (recent) return;
  // cacheGet returns null AND cacheSet returns false when Redis is down, so
  // without this check a Redis outage would fail OPEN and run the ~80-Opus-call
  // eval on every 12h tick. Only proceed once the gate is actually persisted.
  const gateSet = await cacheSet(EVAL_GATE_KEY, Date.now(), EVAL_GATE_SECONDS);
  if (!gateSet) {
    console.warn(
      '[worker:weekly-eval] skipped: Redis unavailable, cannot persist the weekly gate'
    );
    return;
  }

  const s = await runEvalAndEmail({ days: 30, limit: 40 });
  console.log(
    `[worker:weekly-eval] evaluated=${s.evaluated} pass=${s.passRatePct}% ` +
      `aq=${s.avg.addressesQuestion} fc=${s.avg.factualConsistency} cm=${s.avg.completeness}`
  );
}

const EDIT_DIGEST_GATE_KEY = 'edit-digest:last-weekly-run';

async function maybeWeeklyEditDigest(): Promise<void> {
  // Same fail-CLOSED gate shape as the weekly eval: set the 7-day gate first,
  // and skip when Redis can't persist it (else every 12h tick would email).
  const recent = await cacheGet<number>(EDIT_DIGEST_GATE_KEY);
  if (recent) return;
  const gateSet = await cacheSet(EDIT_DIGEST_GATE_KEY, Date.now(), EVAL_GATE_SECONDS);
  if (!gateSet) {
    console.warn(
      '[worker:edit-digest] skipped: Redis unavailable, cannot persist the weekly gate'
    );
    return;
  }

  const s = await runEditDigestAndEmail({ days: 7 });
  console.log(
    `[worker:edit-digest] edits=${s.totalEdits} operators=${s.users} (last ${s.days}d)`
  );
}
const TRIAGE_INTERVAL = parseInt(process.env.TRIAGE_INTERVAL || '20000', 10);
const PRINTIFY_SYNC_INTERVAL = parseInt(
  process.env.PRINTIFY_SYNC_INTERVAL || `${10 * 60 * 1000}`,
  10
);
// Full-walk self-heal cadence (also runs once on the first tick after boot).
const PRINTIFY_FULL_SYNC_INTERVAL = parseInt(
  process.env.PRINTIFY_FULL_SYNC_INTERVAL || `${24 * 60 * 60 * 1000}`,
  10
);
// Hourly is plenty: the drafting path fetches live for shipping questions
// anyway; this just keeps the order-card ETAs reasonably fresh
const TRACKING_REFRESH_INTERVAL = parseInt(
  process.env.TRACKING_REFRESH_INTERVAL || `${60 * 60 * 1000}`,
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
// Background social polling is ONE full pass per day at a fixed hour (see the
// social-sync loop below; SOCIAL_SYNC_HOUR_UTC) - the real comment refresh
// fires when the Social tab is opened in the app (Meta rate-limit care, per
// Pati 2026-06-10; daily-only per Pati 2026-07-05).
const COMMENT_DRAFT_INTERVAL = parseInt(
  process.env.COMMENT_DRAFT_INTERVAL || `${2 * 60 * 1000}`,
  10
);
// DMs arrive in REAL TIME via the Meta webhook (2026-07-08); this loop is a
// slow safety net for missed events only, so daily matches the comment
// sweep. (Pre-webhook this ran 6h to bound the 24h-reply-window risk.)
const MESSENGER_SYNC_INTERVAL = parseInt(
  process.env.MESSENGER_SYNC_INTERVAL || `${24 * 60 * 60 * 1000}`,
  10
);

// Scan Printify support emails (Gmail) for refund/reprint/cancel confirmations
// and auto-tick the Late Deliveries "Refunded by Printify" flag. Hourly - at
// the old 12h cadence a Printify confirmation sat undetected most of a
// working day, which read as "not detecting". A cheap IMAP search when there
// is nothing new. Only runs when Gmail is configured (GMAIL_IMAP_* env).
const PRINTIFY_RECOVERY_INTERVAL = parseInt(
  process.env.PRINTIFY_RECOVERY_INTERVAL || `${60 * 60 * 1000}`,
  10
);

// Daily DB backup (pg_dump -> gzip -> database_backups table). The check runs
// hourly but only backs up when the newest stored backup is older than
// BACKUP_MIN_AGE_MS, so worker restarts don't stack extra backups. This is the
// primary backup path on Railway (the vercel.json cron never fired there).
const BACKUP_CHECK_INTERVAL = parseInt(
  process.env.BACKUP_CHECK_INTERVAL || `${60 * 60 * 1000}`,
  10
);
const BACKUP_MIN_AGE_MS = parseInt(
  process.env.BACKUP_MIN_AGE_MS || `${24 * 60 * 60 * 1000}`,
  10
);

// How long shutdown waits for in-flight loop jobs before exiting anyway
const SHUTDOWN_DRAIN_MS = 20 * 1000;

// Names of loops with a job currently in flight (drained on shutdown)
const activeLoops = new Set<string>();
let shuttingDown = false;

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
    if (running || shuttingDown) return;
    running = true;
    activeLoops.add(name);
    try {
      await job();
    } catch (err) {
      console.error(`[worker:${name}] error:`, err instanceof Error ? err.message : err);
    } finally {
      running = false;
      activeLoops.delete(name);
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
      // Classify only - reply drafts are generated lazily when a thread is
      // opened (always-fresh order data, no stale pre-draft).
      const stats = await runTriageOnlyPass(5);
      if (stats.scanned > 0) {
        console.log(
          `[worker:triage] classified=${stats.processed} failed=${stats.failed}`
        );
      }
    })
  );

  // The frequent pass walks the recent created-at window (catches new orders +
  // status/delivery changes). A full self-heal walk runs once a day to repair
  // any gap left by downtime - the Printify list payload has no updated_at, so
  // an order missed while the worker was down would otherwise sit below the
  // window forever (see src/lib/printify/sync.ts). The last-full-walk stamp is
  // persisted in Redis: with in-memory state every deploy re-ran the full
  // ~500-page walk on boot, and a deploy-heavy day multiplied it (2026-07-05).
  // Redis-down fallback = the old boot-time walk, which is the safe direction.
  const PRINTIFY_FULL_SYNC_KEY = 'worker:printify:last-full-sync';
  let lastPrintifyFullSync = 0;
  timers.push(
    startLoop('printify-sync', PRINTIFY_SYNC_INTERVAL, async () => {
      if (!lastPrintifyFullSync) {
        lastPrintifyFullSync = await readGateStamp(PRINTIFY_FULL_SYNC_KEY);
      }
      const fullSync = Date.now() - lastPrintifyFullSync >= PRINTIFY_FULL_SYNC_INTERVAL;
      // Stamp at START, not completion: full sweeps run tens of minutes, so a
      // deploy landing mid-sweep would otherwise discard the stamp and re-arm
      // a full sweep every boot. A sweep cut short waits for tomorrow's -
      // it's a safety net over the webhook feed, not a correctness gate.
      if (fullSync) {
        lastPrintifyFullSync = Date.now();
        await cacheSet(PRINTIFY_FULL_SYNC_KEY, lastPrintifyFullSync, 7 * 86400);
      }
      const stats = await syncPrintifyOrders({ fullSync });
      console.log(
        `[worker:printify-sync]${fullSync ? ' (full)' : ''}`,
        JSON.stringify(stats)
      );
    })
  );

  // Mine Printify support emails for money recovered (refunds/reprints/cancels)
  // and auto-tick the Late Deliveries tracker. No-op unless Gmail is configured.
  if (gmailConfigFromEnv()) {
    // First run after boot forces a bounded 7-day rescan (ignoring the IMAP
    // watermarks). Incremental scans never re-read an email, so a parser
    // improvement would otherwise never pick up resolutions it missed in
    // already-seen emails; the DB dedup keeps re-scans a no-op.
    let recoveryBooted = false;
    timers.push(
      startLoop('printify-recovery', PRINTIFY_RECOVERY_INTERVAL, async () => {
        const stats = await reconcilePrintifyRecoveries(
          recoveryBooted ? undefined : { sinceDays: 7 }
        );
        recoveryBooted = true;
        // Always log - one line per hour. Silence used to be ambiguous
        // between "not running" and "ran, found nothing", which cost a
        // whole debugging round when the parser was silently missing emails.
        console.log('[worker:printify-recovery]', JSON.stringify(stats));
      })
    );
  } else {
    console.log('[worker] printify-recovery disabled (no GMAIL_IMAP_* env)');
  }

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

  // Pricier self-service swaps parked on a Shopify payment link: apply on
  // payment, revert on expiry. Cheap when idle (one indexed query).
  timers.push(
    startLoop('item-change-payments', 3 * 60 * 1000, async () => {
      const stats = await processPendingItemChanges();
      if (stats.checked > 0) {
        console.log(
          `[worker:item-change-payments] checked=${stats.checked} applied=${stats.applied} reverted=${stats.reverted} failed=${stats.failed}`
        );
      }
    })
  );

  // ONE social pass per day, ALL posts, at a fixed hour (Pati 2026-07-05:
  // "only one call per day for all posts"). Default 23:00 UTC = 7am Manila
  // (PHT has no DST), so the sweep lands right before the VA's workday.
  // Freshness while actually working comes from the tool-open sync - the
  // Social tab fires POST /api/social/sync on open. The loop ticks every
  // 10 min and runs when the most recent daily slot hasn't been served yet,
  // so a worker that was down at the target hour catches up on its next tick
  // instead of skipping a day. Stamp at START (see printify-sync above): a
  // ~50-min scan must not re-arm itself because a deploy rebooted mid-scan.
  const SOCIAL_SYNC_HOUR_UTC = parseInt(
    process.env.SOCIAL_SYNC_HOUR_UTC || '23',
    10
  );
  const SOCIAL_DAILY_KEY = 'worker:social:last-daily-sync';
  let lastSocialDaily = 0;
  timers.push(
    startLoop('social-sync', 10 * 60 * 1000, async () => {
      const now = new Date();
      const due = new Date(now);
      due.setUTCHours(SOCIAL_SYNC_HOUR_UTC, 0, 0, 0);
      if (due > now) due.setUTCDate(due.getUTCDate() - 1); // most recent slot
      if (!lastSocialDaily) {
        lastSocialDaily = await readGateStamp(SOCIAL_DAILY_KEY);
        // Migration fallback: honor the pre-daily-schedule full-scan stamp so
        // switching keys doesn't trigger an extra full pass at deploy time.
        if (!lastSocialDaily) {
          lastSocialDaily = await readGateStamp('worker:social:last-full-scan');
        }
      }
      if (lastSocialDaily >= due.getTime()) return; // this slot already served
      lastSocialDaily = Date.now();
      await cacheSet(SOCIAL_DAILY_KEY, lastSocialDaily, 7 * 86400);
      const results = await syncAllSocialAccounts(true);
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
      const categorized = await categorizeBacklog();
      if (categorized > 0) {
        console.log(`[worker:social-sync] categorized ${categorized} backlog comments`);
      }
      const resolved = await autoResolveComments();
      if (resolved > 0) {
        console.log(`[worker:social-sync] auto-resolved ${resolved} handled/stale comments`);
      }

      // Safety-net auto-like pass (the real one fires on tool open). Rate-limit
      // aware: stops early if Meta usage climbs or we get throttled.
      const likedRes = await autoLikeComments();
      if (likedRes.liked || likedRes.closed || likedRes.stoppedReason === 'rate_limit') {
        console.log(
          `[worker:social-sync] auto-liked ${likedRes.liked} ` +
            `(closed ${likedRes.closed}, remaining ${likedRes.remaining}, stop=${likedRes.stoppedReason})`
        );
      }
    })
  );

  // Daily escalation digest: one morning overview of everything still open
  // (escalated threads + pending Printify escalations), 7am Manila by default
  // so it doubles as the VA's shift-start briefing. Same daily-slot pattern as
  // the social pass: Redis stamp at START, catch-up if the worker was down.
  const ESCALATION_DIGEST_HOUR_UTC = parseInt(
    process.env.ESCALATION_DIGEST_HOUR_UTC || '23',
    10
  );
  const ESCALATION_DIGEST_KEY = 'worker:escalations:last-digest';
  let lastEscalationDigest = 0;
  timers.push(
    startLoop('escalation-digest', 10 * 60 * 1000, async () => {
      const now = new Date();
      const due = new Date(now);
      due.setUTCHours(ESCALATION_DIGEST_HOUR_UTC, 0, 0, 0);
      if (due > now) due.setUTCDate(due.getUTCDate() - 1);
      if (!lastEscalationDigest) {
        lastEscalationDigest = await readGateStamp(ESCALATION_DIGEST_KEY);
      }
      if (lastEscalationDigest >= due.getTime()) return;
      lastEscalationDigest = Date.now();
      await cacheSet(ESCALATION_DIGEST_KEY, lastEscalationDigest, 7 * 86400);
      const stats = await sendEscalationDigest();
      console.log(
        `[worker:escalation-digest] threads=${stats.threads} printify=${stats.printify} sent=${stats.sent}`
      );
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

  // On-demand eval requests from the Settings button - cheap (only runs when
  // an operator clicks), so always available.
  timers.push(startLoop('eval-request', EVAL_REQUEST_POLL_INTERVAL, processEvalRequest));

  // The AUTOMATIC weekly eval is OFF by default - it was firing on every worker
  // deploy (~80 Opus calls a run) and burning credits. Opt back in with
  // EVAL_WEEKLY=1 only if you want the scheduled run again.
  if (process.env.EVAL_WEEKLY === '1') {
    timers.push(startLoop('weekly-eval', EVAL_CHECK_INTERVAL, maybeWeeklyEval));
  }

  // Weekly digest of operator edits to AI drafts (the VA coaching loop). Pure
  // DB reads + one email, no AI calls, so it stays on by default; skips the
  // email entirely on a week with zero real edits. EDIT_DIGEST=0 to disable.
  if (process.env.EDIT_DIGEST !== '0') {
    timers.push(startLoop('edit-digest', EVAL_CHECK_INTERVAL, maybeWeeklyEditDigest));
  }

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

  // Daily database backup. Hourly check, but only runs when the newest backup
  // is older than ~24h - so a boot right after a backup is a no-op, and a
  // worker that was down past the 24h mark backs up on its first tick.
  timers.push(
    startLoop('db-backup', BACKUP_CHECK_INTERVAL, async () => {
      const newest = await latestBackupAt();
      if (newest && Date.now() - newest.getTime() < BACKUP_MIN_AGE_MS) return;
      const result = await runDatabaseBackup();
      console.log(
        `[worker:db-backup] created ${result.filename} ` +
          `(${result.sizeFormatted} -> ${result.compressedSizeFormatted} compressed, ` +
          `pruned ${result.cleanedUp})`
      );
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
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received, draining...`);
    // Stop scheduling new ticks (shuttingDown also blocks any pending initial
    // setTimeout), then give in-flight jobs a bounded window to finish so a
    // redeploy can't cut a sync or backup off mid-write.
    for (const timer of timers) clearInterval(timer);
    const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
    while (activeLoops.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (activeLoops.size > 0) {
      console.warn(
        `[worker] drain timeout, exiting with loops still running: ${[...activeLoops].join(', ')}`
      );
    }
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// A stray rejected promise (e.g. a fire-and-forget cache write) must not crash
// the whole worker - every loop already isolates its own errors.
process.on('unhandledRejection', (reason) => {
  console.error(
    '[worker] unhandled rejection:',
    reason instanceof Error ? reason.message : reason
  );
});

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
