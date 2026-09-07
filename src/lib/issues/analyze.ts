/**
 * Reading the day's customer mail into rows the report can count.
 *
 * One cheap Claude call per batch of inbound messages returns, for each: the
 * category, how bad it is, the design it is about, and one plain sentence. The
 * rows land in customer_issues, keyed on the message id, so the pass can run
 * on an overlapping window forever without a customer ever being counted
 * twice - which matters, because the pattern alarm counts customers.
 *
 * The design name is the part that has to be right. A wrong attribution sends
 * Pati to re-draw artwork that was never the problem, so the name is GROUNDED
 * twice: the model may only choose from designs that customer actually
 * ordered, or name one whose words appear in the customer's own message, and
 * anything else is dropped to null. Not knowing is a fine answer here.
 */

import Anthropic from '@anthropic-ai/sdk';
import { IssueCategory, IssueSeverity } from '@prisma/client';
import prisma from '@/lib/db';
import { getClaudeConfig } from '@/lib/claude';
import { latestReplyText } from '@/lib/email/latest-reply';
import { designBaseTitle } from '@/lib/ai/design-versions';
import { designsForCustomer } from '@/lib/issues/design-lookup';
import { isProductQuality } from '@/lib/issues/categories';

// Classification over short messages - the cheap fast model is the right tool,
// same call shape as the weekly edit-digest synthesis.
const ANALYZE_MODEL = 'claude-haiku-4-5-20251001';

/** How far back a pass looks for messages it has not read yet. */
const WINDOW_HOURS = 48;
/** Messages per Claude call. Keeps the response inside max_tokens. */
const BATCH_SIZE = 20;
/** Messages per pass, across batches. */
const MAX_PER_PASS = 60;
/** Customer text handed to the model. Complaints get to the point early. */
const MAX_MESSAGE_CHARS = 1200;

const CATEGORIES = Object.values(IssueCategory);
const SEVERITIES = Object.values(IssueSeverity);

export interface Candidate {
  messageId: string;
  threadId: string;
  customerEmail: string;
  customerName: string | null;
  subject: string;
  text: string;
  sentAt: Date;
  triageIntent: string | null;
  lineItemHint: string | null;
  orderNumber: string | null;
  designCandidates: string[];
}

export interface AnalyzeStats {
  scanned: number;
  written: number;
  skipped: number;
}

const clip = (t: string, max = MAX_MESSAGE_CHARS) => {
  const s = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
};

const ANALYZE_TOOL: Anthropic.Tool = {
  name: 'report_customer_issues',
  description:
    'Classify each customer email: what it is about, how serious it is, and ' +
    'which design it concerns.',
  input_schema: {
    type: 'object',
    properties: {
      issues: {
        type: 'array',
        description:
          'One entry for EVERY numbered message given, in any order. Never ' +
          'skip a message and never invent one.',
        items: {
          type: 'object',
          properties: {
            index: {
              type: 'integer',
              description: 'The number of the message this entry is for.',
            },
            category: {
              type: 'string',
              enum: CATEGORIES,
              description:
                'The ONE thing this message is mainly about. ' +
                'PRINT_QUALITY = the artwork itself is wrong on the shirt ' +
                '(text unreadable or cut off, print cracked, peeling, faded, ' +
                'blurry, crooked, wrong colors). ' +
                'GARMENT_QUALITY = the blank shirt is at fault (thin fabric, ' +
                'hole, seam, tight neck, shrank, smells). ' +
                'SIZING_FIT = it simply does not fit and they want another ' +
                'size, with nothing faulty. ' +
                'WRONG_ITEM = we shipped a different design, size or color ' +
                'than ordered. ' +
                'NOT_DELIVERED = tracking says delivered or is stalled and ' +
                'they do not have it. ' +
                'SHIPPING_DELAY = it is on the way but taking too long. ' +
                'PRODUCT_QUESTION = asking before buying, nothing is wrong. ' +
                'PRAISE = thanks or a compliment. Use OTHER only when none fit.' +
                '\n\nClassify by the CAUSE, not by the remedy they ask for. ' +
                '"It does not fit, please refund me" is SIZING_FIT; "the ' +
                'print peeled, I want my money back" is PRINT_QUALITY. Use ' +
                'REFUND_RETURN or CANCELLATION only when they give no fault ' +
                'as the reason - they changed their mind, it was a gift they ' +
                'do not want, they ordered by accident. The remedy is what ' +
                'support does about it; the cause is what the shop owner has ' +
                'to fix, and this report exists to show her the cause.',
            },
            severity: {
              type: 'string',
              enum: SEVERITIES,
              description:
                'HIGH = angry, threatening a chargeback or a public review, ' +
                'a second or third email about the same unsolved problem, or ' +
                'a faulty product. MEDIUM = a real problem needing action. ' +
                'LOW = routine, easily answered, or nothing is wrong.',
            },
            design_name: {
              type: 'string',
              description:
                'The design the complaint is about. Pick it from the ' +
                '"designs they ordered" list when the message points at one. ' +
                'If they ordered exactly ONE design, that is the one. If ' +
                'they ordered several and the message does not say which, ' +
                'leave this out - do NOT guess. Leave it out for anything ' +
                'that is not about a physical shirt they received.',
            },
            problem: {
              type: 'string',
              description:
                'The problem in three to six words, close to the customer' +
                "'s own wording, e.g. \"text not readable\", \"print " +
                'cracked after one wash", "neck too tight". Leave out when ' +
                'nothing is wrong.',
            },
            summary: {
              type: 'string',
              description:
                'One plain sentence a shop owner can act on, naming what ' +
                'the customer wants. No jargon, plain hyphens, never an em ' +
                'dash.',
            },
          },
          required: ['index', 'category', 'severity', 'summary'],
        },
      },
    },
    required: ['issues'],
  },
};

/**
 * Keep a design name only if it is grounded: it is one the customer actually
 * ordered, or its distinctive words appear in what they wrote. Returns the
 * canonical spelling plus where it came from, or null to record no design at
 * all. Pure, so the grounding rule is testable without an API call.
 */
export function groundDesignName(
  proposed: string | null | undefined,
  offered: string[],
  messageText: string
): { name: string; source: 'order' | 'customer' } | null {
  const raw = (proposed || '').trim();
  if (!raw) return null;

  const base = designBaseTitle(raw);
  if (base.length < 3) return null;

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const target = norm(base);
  if (!target) return null;

  // 1. It is a design they ordered - the strongest ground there is.
  for (const candidate of offered) {
    const c = norm(candidate);
    if (c === target || c.includes(target) || target.includes(c)) {
      return { name: candidate, source: 'order' };
    }
  }

  // 2. They named it themselves. Every distinctive word of the name has to
  // appear in their message, so "Frog Wizard" passes on a message about the
  // frog wizard shirt and a name the model reached for on its own does not.
  const stop = new Set([
    'the', 'a', 'an', 'and', 'of', 'shirt', 'tee', 't-shirt', 'design', 'premium',
  ]);
  const words = target.split(' ').filter((w) => w.length > 2 && !stop.has(w));
  if (words.length === 0) return null;

  const haystack = norm(messageText);
  if (words.every((w) => haystack.includes(w))) {
    return { name: base, source: 'customer' };
  }

  return null;
}

/**
 * Inbound customer messages in the window that have not been read yet.
 *
 * Vendor pitches and system notifications are dropped (triage calls them
 * SPAM), but a message whose thread has no triage row yet is KEPT - triage
 * runs on its own loop and a real complaint must not be missed just because
 * it arrived a minute ago.
 */
async function findCandidates(): Promise<Candidate[]> {
  const cutoff = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);

  const inWindow = {
    direction: 'INBOUND' as const,
    sentAt: { gte: cutoff },
    thread: {
      status: { not: 'TRASHED' as const },
      OR: [{ triage: { is: null } }, { triage: { intent: { not: 'SPAM' as const } } }],
    },
  };

  // Ids first, bodies second. The whole window is checked for unread messages,
  // not just the newest page of it, so a busy day cannot leave an older
  // message permanently unread behind a wall of newer ones.
  const ids = await prisma.message.findMany({
    where: inWindow,
    select: { id: true },
    orderBy: { sentAt: 'desc' },
    take: 2000,
  });
  if (ids.length === 0) return [];

  const already = await prisma.customerIssue.findMany({
    where: { messageId: { in: ids.map((m) => m.id) } },
    select: { messageId: true },
  });
  const seen = new Set(already.map((a) => a.messageId));

  const unread = ids.filter((m) => !seen.has(m.id)).slice(0, MAX_PER_PASS);
  if (unread.length === 0) return [];

  const fresh = await prisma.message.findMany({
    where: { id: { in: unread.map((m) => m.id) } },
    select: {
      id: true,
      threadId: true,
      subject: true,
      sentAt: true,
      bodyText: true,
      bodyHtml: true,
      thread: {
        select: {
          customerEmail: true,
          customerName: true,
          triage: { select: { intent: true, entities: true } },
        },
      },
    },
    orderBy: { sentAt: 'desc' },
  });

  const candidates: Candidate[] = [];
  for (const m of fresh) {
    const text = clip(latestReplyText({ bodyText: m.bodyText, bodyHtml: m.bodyHtml }));
    // An empty body is an attachment-only or bounced message; there is nothing
    // to classify and a blank one would just become an OTHER row.
    if (text.length < 10) continue;

    const entities = (m.thread.triage?.entities || {}) as Record<string, unknown>;
    const orderNumber =
      typeof entities.orderNumber === 'string' ? entities.orderNumber : null;
    const lineItemHint =
      typeof entities.lineItemHint === 'string' ? entities.lineItemHint : null;

    const designCandidates = await designsForCustomer({
      email: m.thread.customerEmail,
      orderNumber,
    });

    candidates.push({
      messageId: m.id,
      threadId: m.threadId,
      customerEmail: m.thread.customerEmail,
      customerName: m.thread.customerName,
      subject: m.subject || '(no subject)',
      text,
      sentAt: m.sentAt,
      triageIntent: m.thread.triage?.intent ?? null,
      lineItemHint,
      orderNumber,
      designCandidates,
    });
  }

  return candidates;
}

/** The block of text describing one message to the model. */
function renderCandidate(c: Candidate, index: number): string {
  const lines = [`--- Message ${index}`, `From: ${c.customerName || c.customerEmail}`];
  lines.push(`Subject: ${c.subject}`);
  if (c.triageIntent) lines.push(`Desk classified it as: ${c.triageIntent}`);
  if (c.lineItemHint) lines.push(`Product they mentioned: ${c.lineItemHint}`);
  lines.push(
    c.designCandidates.length
      ? `Designs they ordered: ${c.designCandidates.join(' | ')}`
      : 'Designs they ordered: none found'
  );
  lines.push(`They wrote:\n${c.text}`);
  return lines.join('\n');
}

interface RawIssue {
  index?: unknown;
  category?: unknown;
  severity?: unknown;
  design_name?: unknown;
  problem?: unknown;
  summary?: unknown;
}

/** Ask the model about one batch. Returns [] on any failure - never throws. */
async function classifyBatch(
  batch: Candidate[],
  apiKey: string,
  projectId?: string
): Promise<Map<number, RawIssue>> {
  const body = batch.map((c, i) => renderCandidate(c, i + 1)).join('\n\n');

  const userMessage =
    `These are emails customers sent to Summit Soul, a made-to-order t-shirt ` +
    `store (funny nature designs, printed on demand). Classify EVERY message ` +
    `below - one entry each, matched by its number.\n\n` +
    `On the design name: only say which design a message is about when you ` +
    `can tell. If the customer ordered exactly one design, it is that one. If ` +
    `they ordered several and never say which, leave the design out. A wrong ` +
    `design name is worse than none, because it sends the owner to redraw ` +
    `artwork that was never at fault.\n\n${body}`;

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create(
    {
      model: ANALYZE_MODEL,
      max_tokens: 4096,
      tools: [ANALYZE_TOOL],
      tool_choice: { type: 'tool', name: 'report_customer_issues' },
      messages: [{ role: 'user', content: userMessage }],
    },
    projectId ? { headers: { 'anthropic-project': projectId } } : undefined
  );

  const toolUse = response.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === 'tool_use'
  );
  const issues = (toolUse?.input as { issues?: unknown })?.issues;
  const out = new Map<number, RawIssue>();
  if (!Array.isArray(issues)) return out;

  for (const raw of issues as RawIssue[]) {
    const idx = typeof raw?.index === 'number' ? raw.index : NaN;
    if (!Number.isInteger(idx) || idx < 1 || idx > batch.length) continue;
    if (!out.has(idx)) out.set(idx, raw);
  }
  return out;
}

/**
 * Turn one model answer into a row, or null to skip it. Exported for tests:
 * the enum guards and the single-design backstop are the parts that decide
 * whether the pattern alarm counts a customer.
 */
export function buildIssueRow(
  candidate: Candidate,
  raw: RawIssue
): {
  threadId: string;
  messageId: string;
  customerEmail: string;
  customerName: string | null;
  category: IssueCategory;
  severity: IssueSeverity;
  designName: string | null;
  designSource: string | null;
  problem: string | null;
  summary: string;
  occurredAt: Date;
} | null {
  const category = CATEGORIES.includes(raw.category as IssueCategory)
    ? (raw.category as IssueCategory)
    : null;
  if (!category) return null;

  const severity = SEVERITIES.includes(raw.severity as IssueSeverity)
    ? (raw.severity as IssueSeverity)
    : IssueSeverity.LOW;

  const summary =
    typeof raw.summary === 'string' && raw.summary.trim().length > 0
      ? raw.summary.trim().slice(0, 400)
      : null;
  if (!summary) return null;

  let design = groundDesignName(
    typeof raw.design_name === 'string' ? raw.design_name : null,
    candidate.designCandidates,
    `${candidate.subject}\n${candidate.text}\n${candidate.lineItemHint || ''}`
  );

  // Backstop the model's caution: a fault reported by someone who only ever
  // ordered one design is about that design, whether or not they named it.
  if (
    !design &&
    candidate.designCandidates.length === 1 &&
    isProductQuality(category)
  ) {
    design = { name: candidate.designCandidates[0], source: 'order' };
  }

  const problem =
    typeof raw.problem === 'string' && raw.problem.trim().length > 0
      ? raw.problem.trim().slice(0, 120)
      : null;

  return {
    threadId: candidate.threadId,
    messageId: candidate.messageId,
    customerEmail: candidate.customerEmail,
    customerName: candidate.customerName,
    category,
    severity,
    designName: design?.name ?? null,
    designSource: design?.source ?? null,
    problem,
    summary,
    occurredAt: candidate.sentAt,
  };
}

/**
 * Read every unseen inbound message in the window into customer_issues.
 * Returns counts for the worker log. Safe to run as often as you like.
 */
export async function analyzeNewIssues(): Promise<AnalyzeStats> {
  const config = await getClaudeConfig();
  if (!config) return { scanned: 0, written: 0, skipped: 0 };

  const candidates = await findCandidates();
  if (candidates.length === 0) return { scanned: 0, written: 0, skipped: 0 };

  let written = 0;
  let skipped = 0;

  for (let start = 0; start < candidates.length; start += BATCH_SIZE) {
    const batch = candidates.slice(start, start + BATCH_SIZE);

    let answers: Map<number, RawIssue>;
    try {
      answers = await classifyBatch(batch, config.apiKey, config.projectId);
    } catch (err) {
      console.error('[issues] classify batch failed:', err);
      skipped += batch.length;
      continue;
    }

    const rows = batch
      .map((candidate, i) => {
        const raw = answers.get(i + 1);
        return raw ? buildIssueRow(candidate, raw) : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    skipped += batch.length - rows.length;
    if (rows.length === 0) continue;

    // skipDuplicates: a concurrent pass over the same overlapping window must
    // not double-count a customer, and the message id is the unique key.
    const result = await prisma.customerIssue.createMany({
      data: rows,
      skipDuplicates: true,
    });
    written += result.count;
  }

  return { scanned: candidates.length, written, skipped };
}

export const __testing = { clip, renderCandidate };
