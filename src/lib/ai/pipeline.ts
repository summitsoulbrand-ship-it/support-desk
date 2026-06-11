/**
 * AI pre-draft pipeline
 * For each open thread with an unanswered inbound message: classify intent,
 * refresh order/tracking context live, and pre-generate a reply draft so the
 * agent opens the thread with everything ready for review.
 */

import prisma from '@/lib/db';
import { createClaudeService } from '@/lib/claude';
import { buildThreadSuggestionContext } from './context';
import { classifyThread } from './triage';

/** Don't backfill ancient threads when the worker first boots */
const MAX_THREAD_AGE_DAYS = parseInt(process.env.TRIAGE_MAX_AGE_DAYS || '7', 10);
/** Wait before retrying a FAILED draft */
const FAILED_RETRY_MS = 30 * 60 * 1000;
/**
 * A PENDING claim older than this is orphaned (the worker restarted or
 * crashed mid-generation, e.g. on deploy) and gets re-claimed. Normal
 * generation takes well under a minute.
 */
const PENDING_ORPHAN_MS = 10 * 60 * 1000;

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

/**
 * Find open threads whose newest inbound message has no current draft.
 */
export async function findThreadsNeedingDrafts(limit: number): Promise<string[]> {
  const since = new Date(Date.now() - MAX_THREAD_AGE_DAYS * 24 * 60 * 60 * 1000);

  const include = {
    aiDraft: true,
    mailbox: { select: { emailAddress: true } },
    messages: {
      where: { direction: 'INBOUND' as const },
      orderBy: { sentAt: 'desc' as const },
      take: 1,
      select: { id: true },
    },
  };

  // Target threads in draft-needing states directly - a newest-N window
  // silently strands older stuck threads once the inbox is busier than N.
  const targeted = await prisma.thread.findMany({
    where: {
      status: 'OPEN',
      lastMessageAt: { gte: since },
      OR: [
        { aiDraft: null },
        { aiDraft: { status: { in: ['STALE', 'AWAITING_ACTION'] } } },
        {
          aiDraft: {
            status: 'FAILED',
            updatedAt: { lt: new Date(Date.now() - FAILED_RETRY_MS) },
          },
        },
        {
          aiDraft: {
            status: 'PENDING',
            updatedAt: { lt: new Date(Date.now() - PENDING_ORPHAN_MS) },
          },
        },
      ],
    },
    orderBy: { lastMessageAt: 'desc' },
    take: limit * 4,
    include,
  });

  // Backstop: newest threads whose READY draft answers an older message than
  // the latest inbound (normally marked STALE by sync, but belt-and-braces)
  const newest = await prisma.thread.findMany({
    where: {
      status: 'OPEN',
      lastMessageAt: { gte: since },
    },
    orderBy: { lastMessageAt: 'desc' },
    take: limit * 4,
    include,
  });

  const seen = new Set<string>();
  const candidates = [...targeted, ...newest].filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  const needing: string[] = [];
  for (const thread of candidates) {
    if (needing.length >= limit) break;

    const latestInbound = thread.messages[0];
    if (!latestInbound) continue;

    // Own-mailbox threads (e.g. bounces sent to ourselves) are not customers
    if (
      thread.customerEmail.toLowerCase() ===
      thread.mailbox.emailAddress.toLowerCase()
    ) {
      continue;
    }

    // Excluded brand/internal addresses - no classify, no draft, no credits
    if (EXCLUDED_EMAILS.has(thread.customerEmail.toLowerCase())) {
      continue;
    }

    const draft = thread.aiDraft;
    if (!draft) {
      needing.push(thread.id);
      continue;
    }

    // Draft answers an older message, was explicitly marked stale, or was
    // held under the old awaiting-action flow (now drafted upfront)
    if (
      draft.forMessageId !== latestInbound.id ||
      draft.status === 'STALE' ||
      draft.status === 'AWAITING_ACTION'
    ) {
      needing.push(thread.id);
      continue;
    }

    // Retry failures after a cool-down
    if (
      draft.status === 'FAILED' &&
      Date.now() - draft.updatedAt.getTime() > FAILED_RETRY_MS
    ) {
      needing.push(thread.id);
      continue;
    }

    // Re-claim PENDING rows orphaned by a worker restart mid-generation
    if (
      draft.status === 'PENDING' &&
      Date.now() - draft.updatedAt.getTime() > PENDING_ORPHAN_MS
    ) {
      needing.push(thread.id);
    }
  }

  return needing;
}

/**
 * Classify + pre-draft one thread. Errors are recorded on the AiDraft row.
 */
export async function processThread(threadId: string): Promise<boolean> {
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: {
      messages: { orderBy: { sentAt: 'asc' } },
    },
  });
  if (!thread) return false;

  const latestInbound = [...thread.messages]
    .reverse()
    .find((m) => m.direction === 'INBOUND');
  if (!latestInbound) return false;

  // Claim the work: PENDING row keyed to the message being answered
  await prisma.aiDraft.upsert({
    where: { threadId },
    create: {
      threadId,
      forMessageId: latestInbound.id,
      body: '',
      status: 'PENDING',
    },
    update: {
      forMessageId: latestInbound.id,
      status: 'PENDING',
      error: null,
    },
  });

  try {
    // 1. Classify intent
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

    if (triage) {
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
    }

    // Pure thank-you messages need no reply at all - record the
    // classification and skip generation (no credits, no draft). Confidence
    // gate so a misread request still gets a draft.
    if (triage?.intent === 'POSITIVE_FEEDBACK' && triage.confidence >= 0.7) {
      await prisma.aiDraft.update({
        where: { threadId },
        data: {
          forMessageId: latestInbound.id,
          body: '',
          status: 'READY',
          intent: triage.intent,
          model: triage.model,
          error: null,
        },
      });
      return true;
    }

    // Size exchanges: write the confirmation upfront, phrased for the moment
    // the agent approves the exchange (the approve button creates the
    // replacement and sends this reply in one step).
    const replacementDone =
      thread.lastActionType === 'replacement_created' &&
      !!thread.lastActionAt &&
      thread.lastActionAt > latestInbound.sentAt;
    const isPendingExchange = triage?.intent === 'SIZE_EXCHANGE' && !replacementDone;

    // 2. Agent identity: the first admin (solo-operator setup)
    const adminUser = await prisma.user.findFirst({
      where: { role: 'ADMIN' },
      orderBy: { createdAt: 'asc' },
      select: { name: true, signature: true },
    });

    // 3. Build context with LIVE order/tracking data
    const built = await buildThreadSuggestionContext(threadId, {
      forceFresh: true,
      agent: adminUser
        ? { name: adminUser.name, signature: adminUser.signature || undefined }
        : undefined,
    });
    if (!built) throw new Error('Thread disappeared while building context');

    if (isPendingExchange) {
      built.context.extraInstructions =
        'The agent is about to approve this size exchange: a free replacement order in the new size will be created the moment this reply is sent. ' +
        'If the customer named a size, that is the size; if they only asked for bigger/smaller, the replacement is one size up/down from the size on their order - say the resulting size naturally (e.g. "in size L"). ' +
        'Write the confirmation accordingly - the replacement is being made now, made to order, no need to return the original (keep or donate it). ' +
        'Do not ask which size they want and do not ask them to confirm anything.';
    }

    // 4. Generate the draft
    const claudeService = await createClaudeService();
    if (!claudeService) throw new Error('Claude integration not configured');

    const suggestion = await claudeService.generateSuggestion(built.context);

    const warnings = [...built.warnings, ...(suggestion.warnings || [])];

    await prisma.aiDraft.update({
      where: { threadId },
      data: {
        forMessageId: latestInbound.id,
        body: suggestion.draft,
        status: 'READY',
        warnings: warnings.length > 0 ? warnings : undefined,
        intent: triage?.intent,
        model: claudeService.getModel(),
        contextRefreshedAt: built.contextRefreshedAt,
        error: null,
      },
    });

    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[Pipeline] Failed for thread ${threadId}:`, message);
    await prisma.aiDraft.update({
      where: { threadId },
      data: { status: 'FAILED', error: message },
    });
    return false;
  }
}

/**
 * One triage-loop tick: pick up unanswered threads and process them serially.
 */
export async function runTriagePass(batchSize = 5): Promise<PipelineStats> {
  const stats: PipelineStats = { scanned: 0, processed: 0, failed: 0 };

  const threadIds = await findThreadsNeedingDrafts(batchSize);
  stats.scanned = threadIds.length;

  for (const threadId of threadIds) {
    const ok = await processThread(threadId);
    if (ok) stats.processed++;
    else stats.failed++;
  }

  return stats;
}
