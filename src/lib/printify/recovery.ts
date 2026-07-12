/**
 * Printify recovery reconciler.
 *
 * Pulls Printify support emails (merchantsupport@printify.com) from Gmail,
 * parses confirmed outcomes (refund / partial refund / reprint / cancellation),
 * records each as a durable PrintifyRecovery row, and - when the order maps to
 * one of our records - auto-ticks the Late Deliveries "Refunded by Printify"
 * flag so the operator no longer tracks Printify's replies by hand.
 *
 * Matching: emails carry Printify's display number (app_order_id, e.g.
 * "19269685.18793"); our LateOrderResolution / escalations key off the Printify
 * API id (hex). We bridge them via the PrintifyOrderCache, whose `data` JSON
 * contains app_order_id. No Printify API calls - rate-limit friendly.
 */

import prisma from '@/lib/db';
import { cacheDeletePattern, cacheGet, cacheSet, LATE_ORDERS_CACHE_PATTERN } from '@/lib/cache';
import {
  fetchPrintifyEmails,
  gmailConfigFromEnv,
  type GmailReaderConfig,
} from '@/lib/email/gmail-printify-reader';
import { parsePrintifyEmail, type PrintifyResolution } from './email-parser';

const DAY_MS = 24 * 60 * 60 * 1000;
const RESOLVED_BY = 'Printify (auto)';
// IMAP UID watermark so each run fetches only new emails (not the whole window).
// v2: bumped when the parser fix (subject included in the parsed text) shipped.
// v3: shape changed to per-mailbox marks when the TRASH scan was added (the
// operator deletes Printify emails after reading; All Mail excludes Trash, so
// deleted confirmations were invisible). Each bump forces one bounded resync;
// the (appOrderId, type) DB dedup keeps re-seen emails a no-op.
// v4: bumped when DECLINED outcomes were added, so past "we can't refund"
// explanations backfill from already-seen emails.
const IMAP_WATERMARK_KEY = 'printify-recovery:imap-watermark:v4';
const WATERMARK_TTL_SECONDS = 365 * 24 * 60 * 60; // effectively persistent

export interface ReconcileStats {
  emailsScanned: number;
  resolutionsFound: number;
  recoveriesCreated: number;
  trackerTicked: number;
  escalationsClosed: number;
  unmatched: number;
  amountRecoveredUsd: number;
  requestsFound: number;
  awaitingMarked: number;
  answersRecorded: number;
}

/**
 * Build a map of Printify display number (app_order_id) -> API id (hex) from the
 * order cache. Only orders we've synced are matchable; the rest still get a
 * recovery row (unmatched) for the ledger total.
 */
async function buildAppOrderIdMap(): Promise<Map<string, string>> {
  const rows = await prisma.printifyOrderCache.findMany({
    select: { id: true, data: true },
  });
  const map = new Map<string, string>();
  for (const row of rows) {
    const data = row.data as { app_order_id?: string } | null;
    const appId = data?.app_order_id;
    if (appId) map.set(appId, row.id);
  }
  return map;
}

/**
 * Apply one parsed resolution: upsert the recovery row, and if it maps to an
 * order we know, tick the Late Deliveries tracker + close any open escalation.
 * Idempotent - re-running over the same email is a no-op.
 */
async function applyResolution(
  res: PrintifyResolution,
  email: { messageId: string; date: Date; ticketUrl?: string },
  appIdMap: Map<string, string>,
  stats: ReconcileStats
): Promise<void> {
  const hexId = appIdMap.get(res.appOrderId) || null;

  // Dedup at the order+type level (not just per-email): an order is refunded /
  // reprinted / cancelled once, and the same outcome shows up in every later
  // transcript snapshot AND in the manual backfill (which uses a different
  // message id). Order+type dedup keeps the recovered total honest.
  const existing = await prisma.printifyRecovery.findFirst({
    where: { appOrderId: res.appOrderId, type: res.type },
  });

  if (!existing) {
    await prisma.printifyRecovery.create({
      data: {
        appOrderId: res.appOrderId,
        printifyOrderId: hexId,
        type: res.type,
        amountUsd: res.amountUsd ?? null,
        reprintAppOrderId: res.reprintAppOrderId ?? null,
        emailMessageId: email.messageId,
        emailDate: email.date,
        ticketUrl: email.ticketUrl ?? null,
        evidence: res.evidence.slice(0, 2000),
        matched: Boolean(hexId),
      },
    });
    stats.recoveriesCreated += 1;
    if (res.amountUsd) stats.amountRecoveredUsd += res.amountUsd;
  }
  if (!hexId) {
    if (!existing) stats.unmatched += 1;
    return;
  }

  // A DECLINE is Printify's decision too: tick "Refunded by Printify" to NO,
  // but only when still undecided (never overwrite an operator's answer or a
  // confirmed recovery), and leave any open escalation open - no money came.
  if (res.type === 'declined') {
    const tracker = await prisma.lateOrderResolution.findUnique({
      where: { printifyOrderId: hexId },
      select: { refundedByPrintify: true },
    });
    if (tracker?.refundedByPrintify == null) {
      await prisma.lateOrderResolution.upsert({
        where: { printifyOrderId: hexId },
        create: {
          printifyOrderId: hexId,
          refundedByPrintify: false,
          resolvedBy: RESOLVED_BY,
        },
        update: { refundedByPrintify: false, resolvedBy: RESOLVED_BY },
      });
      stats.trackerTicked += 1;
    }
    return;
  }

  // Tick the Late Deliveries "Refunded by Printify" flag. Printify's email is
  // authoritative for this field, so set it true even if previously undecided.
  const tracker = await prisma.lateOrderResolution.findUnique({
    where: { printifyOrderId: hexId },
    select: { refundedByPrintify: true },
  });
  if (tracker?.refundedByPrintify !== true) {
    await prisma.lateOrderResolution.upsert({
      where: { printifyOrderId: hexId },
      create: {
        printifyOrderId: hexId,
        refundedByPrintify: true,
        resolvedBy: RESOLVED_BY,
      },
      update: { refundedByPrintify: true, resolvedBy: RESOLVED_BY },
    });
    stats.trackerTicked += 1;
  }

  // Close any open Printify escalation for this order (Printify handled it).
  const closed = await prisma.printifyEscalation.updateMany({
    where: { printifyOrderId: hexId, printifyHandled: false },
    data: {
      printifyHandled: true,
      printifyHandledAt: email.date,
      printifyHandledBy: RESOLVED_BY,
    },
  });
  stats.escalationsClosed += closed.count;
}

/**
 * Scan recent Printify emails and reconcile recoveries. Safe to call on a loop.
 */
export async function reconcilePrintifyRecoveries(opts?: {
  sinceDays?: number;
  config?: GmailReaderConfig;
}): Promise<ReconcileStats> {
  const stats: ReconcileStats = {
    emailsScanned: 0,
    resolutionsFound: 0,
    recoveriesCreated: 0,
    trackerTicked: 0,
    escalationsClosed: 0,
    unmatched: 0,
    amountRecoveredUsd: 0,
    requestsFound: 0,
    awaitingMarked: 0,
    answersRecorded: 0,
  };

  const config = opts?.config || gmailConfigFromEnv();
  if (!config) {
    throw new Error(
      'Gmail not configured: set GMAIL_IMAP_USER and GMAIL_IMAP_PASSWORD'
    );
  }

  const sinceDays = opts?.sinceDays ?? 120;
  const since = new Date(Date.now() - sinceDays * DAY_MS);

  // Incremental: only pull emails newer than the stored per-mailbox UID
  // watermarks (All Mail + Trash are scanned separately - deleted Printify
  // confirmations live only in Trash). The watermarks live in Redis - if
  // lost, the next run does one bounded date-window resync per mailbox and
  // DB dedup keeps it a no-op. A caller-supplied sinceDays (manual/on-demand)
  // forces a wider rescan by ignoring the marks.
  const forced = typeof opts?.sinceDays === 'number';
  const marks = forced
    ? null
    : await cacheGet<Record<string, { lastUid: number; uidValidity: number }>>(
        IMAP_WATERMARK_KEY
      );

  const { emails, watermarks } = await fetchPrintifyEmails(config, {
    sinceFallback: since,
    watermarks: marks ?? undefined,
  });

  // Persist the advanced watermarks (skip on forced rescans so we don't
  // clobber good marks with a wide-window result).
  if (!forced && Object.values(watermarks).some((w) => w.lastUid > 0)) {
    await cacheSet(IMAP_WATERMARK_KEY, watermarks, WATERMARK_TTL_SECONDS);
  }

  stats.emailsScanned = emails.length;
  if (emails.length === 0) return stats;

  const appIdMap = await buildAppOrderIdMap();

  // Resolutions first, so a request that was answered in the same scan never
  // also gets flagged "awaiting". Track which orders got a resolution this run.
  const resolvedThisRun = new Set<string>();
  // Earliest request per order (intent + date), applied after resolutions.
  const pendingRequests = new Map<
    string,
    { intent: string; date: Date }
  >();
  // Newest per-order support answer across all emails in this scan.
  const latestAnswers = new Map<string, { text: string; date: Date }>();

  for (const email of emails) {
    // Parse subject + body together: Printify's follow-up confirmations
    // ("the order has been canceled and refunded...") carry the order number
    // ONLY in the subject line ("Re: ... Order 19269685.19389") - body-only
    // parsing extracted nothing from exactly the emails that matter most.
    const { resolutions, requests, answers } = parsePrintifyEmail(
      `${email.subject}\n${email.text}`
    );
    for (const a of answers) {
      const prev = latestAnswers.get(a.appOrderId);
      if (!prev || email.date >= prev.date) {
        latestAnswers.set(a.appOrderId, { text: a.text, date: email.date });
      }
    }
    stats.resolutionsFound += resolutions.length;
    stats.requestsFound += requests.length;
    const ticketUrl = email.text.match(
      /https:\/\/help\.printify\.com\/hc\/requests\/\d+/
    )?.[0];
    for (const res of resolutions) {
      resolvedThisRun.add(res.appOrderId);
      await applyResolution(
        res,
        { messageId: email.messageId, date: email.date, ticketUrl },
        appIdMap,
        stats
      );
    }
    for (const req of requests) {
      const prev = pendingRequests.get(req.appOrderId);
      if (!prev || email.date < prev.date) {
        pendingRequests.set(req.appOrderId, { intent: req.intent, date: email.date });
      }
    }
  }

  for (const [appOrderId, req] of pendingRequests) {
    if (resolvedThisRun.has(appOrderId)) continue;
    await applyRequest(appOrderId, req, appIdMap, stats);
  }

  // Store each order's newest support answer on the Late Deliveries tracker
  // (only when newer than what's already recorded - re-scans are no-ops).
  for (const [appOrderId, ans] of latestAnswers) {
    const hexId = appIdMap.get(appOrderId);
    if (!hexId) continue;
    const existing = await prisma.lateOrderResolution.findUnique({
      where: { printifyOrderId: hexId },
      select: { printifyAnswerAt: true, printifyAnswer: true },
    });
    // Skip only when the stored answer is STRICTLY newer - a same-date rescan
    // may carry a cleaner rendering of the same line and should replace it.
    if (existing?.printifyAnswerAt && existing.printifyAnswerAt > ans.date) {
      continue;
    }
    const text = ans.text.slice(0, 1000);
    if (existing?.printifyAnswer === text) continue;
    await prisma.lateOrderResolution.upsert({
      where: { printifyOrderId: hexId },
      create: {
        printifyOrderId: hexId,
        printifyAnswer: text,
        printifyAnswerAt: ans.date,
      },
      update: { printifyAnswer: text, printifyAnswerAt: ans.date },
    });
    stats.answersRecorded += 1;
  }

  if (
    stats.trackerTicked > 0 ||
    stats.awaitingMarked > 0 ||
    stats.answersRecorded > 0
  ) {
    await cacheDeletePattern(LATE_ORDERS_CACHE_PATTERN);
  }
  return stats;
}

/**
 * Flag an order as "awaiting Printify": we asked (refund/reprint/cancel) but no
 * confirmation has come back. Only set when the Printify decision is still
 * undecided AND no recovery exists yet, and never overwrite an earlier request.
 */
async function applyRequest(
  appOrderId: string,
  req: { intent: string; date: Date },
  appIdMap: Map<string, string>,
  stats: ReconcileStats
): Promise<void> {
  const hexId = appIdMap.get(appOrderId);
  if (!hexId) return;

  // A confirmed recovery means it's no longer awaiting.
  const recovered = await prisma.printifyRecovery.findFirst({
    where: { printifyOrderId: hexId },
    select: { id: true },
  });
  if (recovered) return;

  const existing = await prisma.lateOrderResolution.findUnique({
    where: { printifyOrderId: hexId },
    select: { refundedByPrintify: true, printifyRequestedAt: true },
  });
  // Decided already (yes/no), or already flagged - leave it.
  if (existing?.refundedByPrintify != null) return;
  if (existing?.printifyRequestedAt) return;

  await prisma.lateOrderResolution.upsert({
    where: { printifyOrderId: hexId },
    create: {
      printifyOrderId: hexId,
      printifyRequestedAt: req.date,
      printifyRequestIntent: req.intent,
    },
    update: { printifyRequestedAt: req.date, printifyRequestIntent: req.intent },
  });
  stats.awaitingMarked += 1;
}

// Throttle so repeated opens of the Late Deliveries tab don't re-scan the inbox
// every load. At most once per window; the daily worker loop is the safety net.
const RECONCILE_THROTTLE_KEY = 'printify-recovery:last-run';
// On-tab-open refresh: fires when the operator actually opens Late Deliveries,
// so keep it responsive (at most hourly) - distinct from the 12h background
// worker loop. This is what makes a manual check pick up new Printify emails.
const RECONCILE_THROTTLE_SECONDS = 60 * 60; // at most once per hour on tab open

/**
 * Fire-and-forget reconcile for "on tool open": runs at most once per throttle
 * window, only when Gmail is configured, and never throws into the caller. Call
 * with `void maybeReconcilePrintifyRecoveries()` so the tab loads immediately.
 */
export async function maybeReconcilePrintifyRecoveries(): Promise<void> {
  try {
    if (!gmailConfigFromEnv()) return;
    const recent = await cacheGet<number>(RECONCILE_THROTTLE_KEY);
    if (recent) return;
    // Set the flag FIRST so two opens in the same window can't both kick a scan.
    await cacheSet(RECONCILE_THROTTLE_KEY, Date.now(), RECONCILE_THROTTLE_SECONDS);
    const stats = await reconcilePrintifyRecoveries();
    if (stats.recoveriesCreated > 0 || stats.trackerTicked > 0) {
      console.log('[printify-recovery] on-open scan:', JSON.stringify(stats));
    }
  } catch (err) {
    console.error('[printify-recovery] on-open scan failed:', err);
  }
}
