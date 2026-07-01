/**
 * AI triage pipeline (lazy-draft mode)
 * The background worker only CLASSIFIES unanswered threads; the reply draft
 * itself is generated on demand when the operator opens the thread (via
 * /api/threads/[id]/suggest, which also runs the verifyDraft QA pass). The
 * old pre-draft path (findThreadsNeedingDrafts/processThread/runTriagePass)
 * was removed 2026-07 - it had no callers; its tuned size-exchange phrasing
 * now lives in buildThreadSuggestionContext so the live path uses it.
 */

import prisma from '@/lib/db';
import { classifyThread } from './triage';

/** Don't backfill ancient threads when the worker first boots */
const MAX_THREAD_AGE_DAYS = parseInt(process.env.TRIAGE_MAX_AGE_DAYS || '7', 10);

/**
 * Addresses that never get auto-classified or drafted (own brand inboxes,
 * forwards to ourselves, etc.). The support mailbox itself is always excluded
 * separately. Extend via DRAFT_EXCLUDED_EMAILS (comma-separated).
 */
const EXCLUDED_EMAILS = new Set(
  [
    'summitsoulbrand@gmail.com',
    ...(process.env.DRAFT_EXCLUDED_EMAILS || '')
      .split(',')
      .map((e) => e.trim()),
  ]
    .filter(Boolean)
    .map((e) => e.toLowerCase())
);

export interface PipelineStats {
  scanned: number;
  processed: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Lazy-draft mode (current): the background worker only CLASSIFIES threads -
// cheap, and it keeps the inbox's intent badges / action buttons populated.
// The actual reply DRAFT is generated on demand when the operator opens the
// thread (via /api/threads/[id]/suggest), so it always uses fresh order data
// instead of a pre-draft that can go stale between arrival and open.
// ---------------------------------------------------------------------------

/** Threads whose latest inbound message hasn't been classified yet. */
export async function findThreadsNeedingTriage(limit: number): Promise<string[]> {
  const since = new Date(Date.now() - MAX_THREAD_AGE_DAYS * 24 * 60 * 60 * 1000);
  const threads = await prisma.thread.findMany({
    where: { status: 'OPEN', lastMessageAt: { gte: since } },
    include: {
      triage: { select: { classifiedMessageId: true } },
      mailbox: { select: { emailAddress: true } },
      messages: {
        where: { direction: 'INBOUND' as const },
        orderBy: { sentAt: 'desc' as const },
        take: 1,
        select: { id: true },
      },
    },
    orderBy: { lastMessageAt: 'desc' },
    take: limit * 4,
  });

  const needing: string[] = [];
  for (const thread of threads) {
    if (needing.length >= limit) break;
    const latestInbound = thread.messages[0];
    if (!latestInbound) continue;
    // Own-mailbox bounces and excluded brand/internal addresses aren't customers.
    if (
      thread.customerEmail.toLowerCase() === thread.mailbox.emailAddress.toLowerCase()
    )
      continue;
    if (EXCLUDED_EMAILS.has(thread.customerEmail.toLowerCase())) continue;
    // Already classified for this exact inbound message - nothing to do.
    if (thread.triage?.classifiedMessageId === latestInbound.id) continue;
    needing.push(thread.id);
  }
  return needing;
}

/**
 * Classify ONE thread's latest inbound (intent + entities); do NOT generate a
 * reply draft. No-reply intents (praise / unsubscribe / spam) get an empty
 * READY draft so the inbox marks them handled without spending a generation;
 * actionable intents are left draft-less and generated on open.
 */
export async function triageThreadOnly(threadId: string): Promise<boolean> {
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: { messages: { orderBy: { sentAt: 'asc' } } },
  });
  if (!thread) return false;

  const latestInbound = [...thread.messages]
    .reverse()
    .find((m) => m.direction === 'INBOUND');
  if (!latestInbound) return false;

  const bodyOf = (m: typeof latestInbound) =>
    m.bodyText || m.bodyHtml?.replace(/<[^>]*>/g, '') || '';
  const prior = thread.messages
    .filter((m) => m.id !== latestInbound.id)
    .map((m) => ({
      from: m.direction === 'INBOUND' ? 'Customer' : 'Support',
      body: bodyOf(m).slice(0, 800),
    }));

  const triage = await classifyThread({
    subject: thread.subject,
    latestMessage: bodyOf(latestInbound),
    priorMessages: prior,
  });
  if (!triage) return false;

  await prisma.threadTriage.upsert({
    where: { threadId },
    create: {
      threadId,
      intent: triage.intent,
      confidence: triage.confidence,
      entities: JSON.parse(JSON.stringify(triage.entities)),
      classifiedMessageId: latestInbound.id,
      model: triage.model,
    },
    update: {
      intent: triage.intent,
      confidence: triage.confidence,
      entities: JSON.parse(JSON.stringify(triage.entities)),
      classifiedMessageId: latestInbound.id,
      model: triage.model,
    },
  });

  if (
    (triage.intent === 'UNSUBSCRIBE' ||
      triage.intent === 'SPAM') &&
    triage.confidence >= 0.7
  ) {
    await prisma.aiDraft.upsert({
      where: { threadId },
      create: {
        threadId,
        forMessageId: latestInbound.id,
        body: '',
        status: 'READY',
        intent: triage.intent,
        model: triage.model,
      },
      update: {
        forMessageId: latestInbound.id,
        body: '',
        status: 'READY',
        intent: triage.intent,
        model: triage.model,
        error: null,
      },
    });
  }
  return true;
}

/** Background pass: classify threads only. Drafts are generated lazily on open. */
export async function runTriageOnlyPass(batchSize = 5): Promise<PipelineStats> {
  const stats: PipelineStats = { scanned: 0, processed: 0, failed: 0 };
  const threadIds = await findThreadsNeedingTriage(batchSize);
  stats.scanned = threadIds.length;
  for (const threadId of threadIds) {
    try {
      const ok = await triageThreadOnly(threadId);
      if (ok) stats.processed++;
      else stats.failed++;
    } catch (err) {
      stats.failed++;
      console.error('[triage-only] failed for', threadId, err);
    }
  }
  return stats;
}
