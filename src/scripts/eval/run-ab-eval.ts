/**
 * A/B draft-accuracy eval: CURRENT pipeline vs a SIMPLIFIED "TacoDog-style"
 * drafter, on the SAME threads, scored by the SAME judge.
 *
 * Goal: test Pati's hypothesis that the desk's drafting brain is over-complex.
 * Grounding is held CONSTANT - both arms get the exact same facts block
 * (renderContextForReview). The ONLY difference is the brain:
 *   - Arm A (current): full system prompt + golden templates + verify pass.
 *   - Arm B (simple):  one lean system prompt (brand voice + closed actions +
 *                      guard rails), single call, no templates, no verify.
 *
 * Usage (needs prod DB + Claude config):
 *   npx tsx src/scripts/eval/run-ab-eval.ts --days 30 --limit 10
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { Prisma } from '@prisma/client';
import prisma from '@/lib/db';
import { createClaudeService, getClaudeConfig } from '@/lib/claude';
import { normalizeModel } from '@/lib/claude/service';
import { BRAND_VOICE_GUIDELINES, STORE_POLICY_FACTS, ISSUE_HANDLING_RULES } from '@/lib/claude/brand-voice';
import { buildThreadSuggestionContext } from '@/lib/ai/context';
import { latestReplyText } from '@/lib/email/latest-reply';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// Arm B = the production-candidate "simple brain": the few critical guard rails
// LED UP TOP (the ones the baseline eval showed the desk failing - they exist in
// today's prompt too, but buried on line ~61 of a 29-item policy wall, so the
// model ignores them), then the SAME policy facts KEPT as reference below (so
// policy questions don't regress). Drops the verbose "how to write" preamble and
// the golden-template "mirror it" scaffolding of the current prompt.
const B2_SIMPLE = `You are Pati, owner of Summit Soul, a small made-to-order nature / rock-hound t-shirt brand. You write customer-service email replies that are READY TO SEND. Every shirt is printed to order (about 1-4 business days in production, then 2-5 business days shipping), so a recent order is usually still being made, not lost.

## TOP RULES - follow these before anything else
1. Answer the customer's LATEST message and EVERY question or request in it. Add nothing they did not raise (no extra discount, tree-planting line, or compliment). Do not write as if mid-conversation, and never thank them for a compliment they did not give.
2. SHIPPING-STATUS HONESTY: state only a status the facts show. If "Has it actually shipped: NO", the order is still in production - say that and give the estimate. Never say shipped / in transit / delivered, and never invent a delivery date, time, or location, unless the Carrier Tracking facts show it.
3. NEVER invent a fact you cannot see in the context - tracking number, date, refund amount, order or production status, item, color, or fabric percentage. If you do not have it, say you are checking.
4. If the customer explicitly asks for a refund or to return the item, honor it: refund to the original payment, nothing to ship back. Do NOT push an exchange instead.
5. A size/fit issue, or anything WE got wrong (wrong item, wrong size, defect), is a FREE replacement at any stage - they keep or donate the original. A customer's own change to an order (address, size, cancel) is only possible BEFORE production starts.
6. NEVER use em dashes (plain hyphens only). Output ONLY the ready-to-send email: open "Hi [First name]," then short paragraphs, then the signature provided in the context (or "Best, Pati / Summit Soul" if none). No markdown, no notes.

## Reference facts (consult for specifics; do not dump these at the customer)
${BRAND_VOICE_GUIDELINES}

${STORE_POLICY_FACTS}

${ISSUE_HANDLING_RULES}`;

interface Judgement {
  addressesQuestion: number;
  factualConsistency: number;
  completeness: number;
  tone: number;
  pass: boolean;
  failureModes: string[];
  note: string;
}

function avg(rs: Judgement[], k: keyof Judgement): number {
  if (!rs.length) return 0;
  return +(rs.reduce((s, r) => s + (r[k] as number), 0) / rs.length).toFixed(2);
}
function passPct(rs: Judgement[]): number {
  if (!rs.length) return 0;
  return +((rs.filter((r) => r.pass).length / rs.length) * 100).toFixed(0);
}
function modes(rs: Judgement[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of rs) for (const f of r.failureModes) m[f] = (m[f] || 0) + 1;
  return m;
}

async function main(): Promise<void> {
  const days = parseInt(arg('days', '30'), 10);
  const limit = parseInt(arg('limit', '10'), 10);
  const since = new Date(Date.now() - days * 86400 * 1000);

  const claude = await createClaudeService();
  if (!claude) throw new Error('Claude not configured.');
  const cfg = await getClaudeConfig();
  if (!cfg) throw new Error('Claude config not available.');
  const raw = new Anthropic({ apiKey: cfg.apiKey });
  const model = normalizeModel(cfg.model) || 'claude-opus-4-8';

  // Thread selection. With --threads <file> (a JSON array of thread ids), grade
  // EXACTLY those (e.g. the hard cases that failed a prior run) so the A/B is a
  // like-for-like rematch, not a fresh random sample. Otherwise random-sample
  // recent threads with a human OUTBOUND reply, like run-draft-eval.
  type ThreadWithMessages = Prisma.ThreadGetPayload<{ include: { messages: true } }>;
  const threadsFile = arg('threads', '');
  let threads: ThreadWithMessages[];
  if (threadsFile) {
    const ids: string[] = JSON.parse(readFileSync(threadsFile, 'utf8'));
    const found = await prisma.thread.findMany({
      where: { id: { in: ids } },
      include: { messages: { orderBy: { sentAt: 'asc' } } },
    });
    const byId = new Map(found.map((t) => [t.id, t]));
    threads = ids.map((id) => byId.get(id)).filter((t): t is ThreadWithMessages => !!t);
  } else {
    const pool = await prisma.thread.findMany({
      where: { updatedAt: { gte: since }, messages: { some: { direction: 'OUTBOUND' } } },
      include: { messages: { orderBy: { sentAt: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(limit * 8, 600),
    });
    threads = [...pool];
    for (let i = threads.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [threads[i], threads[j]] = [threads[j], threads[i]];
    }
  }

  const cases: Array<{ threadId: string; subject: string; customerMessage: string; reference: string }> = [];
  for (const t of threads) {
    const inbound = t.messages.filter((m) => m.direction === 'INBOUND');
    const outbound = t.messages.filter((m) => m.direction === 'OUTBOUND');
    if (!inbound.length || !outbound.length) continue;
    const lastOut = outbound[outbound.length - 1];
    const priorInbound = inbound.filter((m) => m.sentAt <= lastOut.sentAt);
    if (!priorInbound.length) continue;
    const customerMessage = priorInbound
      .map((m) => latestReplyText({ subject: m.subject, bodyText: m.bodyText, bodyHtml: m.bodyHtml }))
      .join('\n\n---\n\n');
    const reference = latestReplyText({ subject: lastOut.subject, bodyText: lastOut.bodyText, bodyHtml: lastOut.bodyHtml });
    if (reference.trim().length < 15) continue;
    cases.push({ threadId: t.id, subject: t.subject || '(no subject)', customerMessage, reference });
    if (cases.length >= limit) break;
  }

  console.log(`A/B over ${cases.length} threads (last ${days} days)\n`);

  const aScores: Judgement[] = [];
  const bScores: Judgement[] = [];
  const rows: Array<Record<string, unknown>> = [];

  for (const c of cases) {
    try {
      const built = await buildThreadSuggestionContext(c.threadId, { forceFresh: false });
      if (!built) continue;

      // Identical grounded facts for both arms.
      const facts = claude.renderContextForReview(built.context);

      // Arm A: current pipeline.
      const a = await claude.generateSuggestion(built.context);
      const draftA = (a.draft || '').trim();

      // Arm B: lean single-prompt drafter on the SAME facts.
      const bResp = await raw.messages.create({
        model,
        max_tokens: 1024,
        system: B2_SIMPLE,
        messages: [{ role: 'user', content: facts }],
      });
      const bText = bResp.content.find((x) => x.type === 'text');
      const draftB = bText && bText.type === 'text' ? bText.text.trim() : '';

      if (!draftA || !draftB) continue;

      const [sa, sb] = await Promise.all([
        claude.judgeDraft({ customerMessage: c.customerMessage, draft: draftA, reference: c.reference }),
        claude.judgeDraft({ customerMessage: c.customerMessage, draft: draftB, reference: c.reference }),
      ]);
      aScores.push(sa);
      bScores.push(sb);
      rows.push({
        subject: c.subject,
        customerMessage: c.customerMessage,
        reference: c.reference,
        A: { draft: draftA, score: sa },
        B: { draft: draftB, score: sb },
      });

      const tag = (s: Judgement) => `${s.pass ? 'PASS' : 'FAIL'}(aq${s.addressesQuestion}/fc${s.factualConsistency}/cm${s.completeness})`;
      console.log(`- ${(c.subject || '').slice(0, 42).padEnd(42)}  A:${tag(sa).padEnd(22)} B:${tag(sb)}`);
    } catch (e) {
      console.log(`- ${c.subject}: error ${e instanceof Error ? e.message : e}`);
    }
  }

  const summary = {
    when: new Date().toISOString(),
    n: aScores.length,
    A_current: {
      passRatePct: passPct(aScores),
      avg: { aq: avg(aScores, 'addressesQuestion'), fc: avg(aScores, 'factualConsistency'), cm: avg(aScores, 'completeness'), tone: avg(aScores, 'tone') },
      failureModes: modes(aScores),
    },
    B_simple: {
      passRatePct: passPct(bScores),
      avg: { aq: avg(bScores, 'addressesQuestion'), fc: avg(bScores, 'factualConsistency'), cm: avg(bScores, 'completeness'), tone: avg(bScores, 'tone') },
      failureModes: modes(bScores),
    },
  };

  console.log('\n=== A/B SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));

  const outDir = path.join(process.cwd(), 'eval-reports');
  mkdirSync(outDir, { recursive: true });
  const stamp = summary.when.slice(0, 19).replace(/[:T]/g, '-');
  writeFileSync(path.join(outDir, `ab-${stamp}.json`), JSON.stringify({ summary, rows }, null, 2));
  console.log(`\nWrote eval-reports/ab-${stamp}.json`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
