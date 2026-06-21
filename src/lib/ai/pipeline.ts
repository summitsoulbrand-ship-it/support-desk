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

    // Pure thank-you messages, unsubscribe requests, and non-customer mail
    // (vendor/SEO/marketing pitches, system notifications) need no written
    // reply - record the classification and skip generation (no credits, no
    // draft). Unsubscribe is handled by the Unsubscribe action, not a reply.
    // Confidence gate so a misread request still gets a draft.
    if (
      (triage?.intent === 'POSITIVE_FEEDBACK' ||
        triage?.intent === 'UNSUBSCRIBE' ||
        triage?.intent === 'SPAM') &&
      triage.confidence >= 0.7
    ) {
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
    // A size exchange where the claimed size isn't on any order is NOT a
    // clean pending exchange - the draft must clarify, not confirm. The
    // exchangeSizeIssue check is set in buildThreadSuggestionContext below,
    // so re-evaluate after the context is built.
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

    // The claimed size isn't on any order - never auto-confirm; ask instead.
    if (isPendingExchange && built.context.exchangeSizeIssue) {
      const { claimedSize, orderNumber, orderedSizes } =
        built.context.exchangeSizeIssue;
      built.context.extraInstructions =
        `IMPORTANT: the customer says they have a size ${claimedSize}, but ${orderNumber} does not contain a ${claimedSize} ` +
        `(it has ${orderedSizes.length ? orderedSizes.join(' and ') : 'no sized apparel'}). ` +
        'Do NOT confirm or create a replacement. Gently point out what their order actually shows, and ask them to confirm which item and size they have so you set up the right exchange. ' +
        'Stay warm and helpful - assume an honest mix-up, not a problem.';
    } else if (isPendingExchange) {
      const exEntities =
        (triage?.entities as {
          requestedColor?: string;
          exchangeItems?: { itemHint?: string; requestedSize?: string; sizeDirection?: 'up' | 'down'; requestedColor?: string }[];
        } | null) || {};
      const multi = exEntities.exchangeItems && exEntities.exchangeItems.length > 1;
      const multiNote = multi
        ? `The customer is exchanging more than one item: ${exEntities
            .exchangeItems!.map((e) => {
              const t = [
                e.requestedSize ? `size ${e.requestedSize}` : e.sizeDirection ? `one size ${e.sizeDirection}` : '',
                e.requestedColor || '',
              ]
                .filter(Boolean)
                .join(', ');
              return `${e.itemHint || 'item'} -> ${t || 'new size'}`;
            })
            .join('; ')}. If they are ALL going to the same new size, just say "shirts" in that size - do NOT list each product; only name each item with its size if the sizes differ. `
        : '';
      // Pre-production (not yet sent to print): the approve button EDITS the
      // existing order in place - there is NO replacement order. Wording has to
      // match, or the draft promises a "replacement" that never gets created.
      // context.changeBeforeProduction is set in buildThreadSuggestionContext
      // when the matched Printify order can still be cancelled.
      const isChangeBeforeProduction = !!built.context.changeBeforeProduction;
      const changeNoun = isChangeBeforeProduction ? 'change' : 'replacement';
      const colorNote =
        !multi && exEntities.requestedColor
          ? `The customer also asked for a different color (${exEntities.requestedColor}); the ${changeNoun} is in that new color, so confirm the new size AND color naturally (e.g. "in size L, in ${exEntities.requestedColor}"). `
          : '';

      if (isChangeBeforeProduction) {
        // The order is edited in place before it prints. No replacement, no
        // duplicate, nothing to return/keep/donate.
        built.context.extraInstructions =
          'The agent is about to approve this change: their EXISTING order will be UPDATED to the new size/color before it goes to print. This is NOT a replacement - there is no second order, nothing to return, keep, or donate. ' +
          'If the customer named a size, that is the size; if they only asked for bigger/smaller, the new size is one up/down from the size on their order - say the resulting size naturally (e.g. "in size L"). ' +
          multiNote +
          colorNote +
          'Confirm warmly that we caught it in time and are updating their order now, at no extra cost. Do NOT use the word "replacement" or talk about creating a new/second order or sending anything back. ' +
          'Do not ask which size or color they want and do not ask them to confirm anything.';
      } else {
        // Already in production / shipped / delivered: a free replacement order
        // is created. The opening sentence has to fit the stage of the ORIGINAL
        // order. The "since each shirt is made to order, we can't swap the size
        // on this one" reasoning only explains why an order still PRINTING is
        // locked - it is a non-sequitur for a shirt the customer already has in
        // hand (or one already on its way). For shipped/delivered originals,
        // open on the real reason and go straight to the free replacement.
        const ti = built.context.trackingInfo;
        const openingNote = ti?.isDelivered
          ? 'IMPORTANT - this original order has ALREADY BEEN DELIVERED. Do NOT open with the made-to-order production-lock line ("since each shirt is made to order, we are not able to swap the size on this order") - that explains why an order still being printed is locked and makes no sense for a shirt they already have. Instead open by warmly acknowledging that because their order has already been delivered we cannot change that original one, then move straight to setting up the free replacement. '
          : ti?.hasShipped
            ? 'IMPORTANT - this original order has already SHIPPED and is on its way to the customer. Do NOT justify the no-swap with "each shirt is made to order" - simply note that their original is already on its way so we cannot change it, then move straight to the free replacement. '
            : '';
        built.context.extraInstructions =
          openingNote +
          'The exchange is APPROVED and the free replacement is being made now. Confirm it warmly and SIMPLY, mirroring this exact style (adapt the size and singular/plural to their order): ' +
          '"I\'ve got you covered! I just set up a free replacement for your [shirt(s)] in [new size] - it\'s going into production today. You can keep or donate the original [shirt(s)] since having you ship them back would just create unnecessary waste and carbon emissions. You\'ll get tracking info as soon as your new shirts ship!" ' +
          'If the customer named a size, that is the size; if they only asked for bigger/smaller, it is one size up/down from the size on their order. ' +
          multiNote +
          colorNote +
          'Keep it short and warm, like that example. Do NOT invent an order number (we do not have the new order number yet), do NOT say "same address on file", do NOT list each product by name (just say "shirt"/"shirts") UNLESS the items are going to DIFFERENT sizes, do NOT give a specific tracking number or delivery date, and do NOT ask them to confirm anything.';
      }
    }

    // 4. Generate the draft
    const claudeService = await createClaudeService();
    if (!claudeService) throw new Error('Claude integration not configured');

    const suggestion = await claudeService.generateSuggestion(built.context);

    // Independent verify pass ("review beats generate"): a separate model
    // re-reads the same facts and flags drafts that miss the question, cite the
    // wrong order, or invent facts. Surfaced as warnings - never blocks.
    const verdict = await claudeService.verifyDraft(built.context, suggestion.draft);

    const warnings = [
      ...built.warnings,
      ...(suggestion.warnings || []),
      ...verdict.issues,
    ];

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
    (triage.intent === 'POSITIVE_FEEDBACK' ||
      triage.intent === 'UNSUBSCRIBE' ||
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
