/**
 * Offline accuracy eval for the AI draft pipeline (the measurement foundation).
 *
 * For recent threads that have a real human-sent reply, it regenerates a fresh
 * draft from the SAME context the pipeline uses and an LLM-as-judge scores that
 * draft against the reply the human actually sent (the ground truth) on:
 * addresses-question, factual-consistency, completeness, tone - plus a failure
 * mode breakdown (missed_question, wrong_order, hallucinated_fact, missed_item,
 * ignored_prior_email, ...).
 *
 * Run it, change a prompt, run it again: the scores tell you whether the change
 * helped or hurt instead of guessing. Writes a JSON + Markdown report to
 * ./eval-reports/.
 *
 * Usage (needs DB + ANTHROPIC_API_KEY env, run against a copy of prod data):
 *   npx tsx src/scripts/eval/run-eval.ts --days 30 --limit 40
 *
 * SCOPE: this exercises the core drafting path (system prompt + assembled
 * context + clean messages -> draft), which is exactly what comprehension and
 * prompt changes affect. It does not replay the per-intent situational
 * instructions the live pipeline adds, so treat the absolute numbers as a
 * comparable BASELINE for regression, not a production SLA.
 */

import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import prisma from '@/lib/db';
import { createClaudeService } from '@/lib/claude';
import { buildThreadSuggestionContext } from '@/lib/ai/context';
import { latestReplyText } from '@/lib/email/latest-reply';

interface EvalCase {
  threadId: string;
  subject: string;
  customerMessage: string;
  reference: string;
}

type Judgement = Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof createClaudeService>>>['judgeDraft']>>;

interface EvalResult extends EvalCase {
  draft: string;
  score: Judgement;
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main(): Promise<void> {
  const days = parseInt(arg('days', '30'), 10);
  const limit = parseInt(arg('limit', '40'), 10);
  const since = new Date(Date.now() - days * 86400 * 1000);

  const claude = await createClaudeService();
  if (!claude) throw new Error('Claude not configured (set ANTHROPIC_API_KEY).');

  const threads = await prisma.thread.findMany({
    where: {
      updatedAt: { gte: since },
      messages: { some: { direction: 'OUTBOUND' } },
    },
    include: { messages: { orderBy: { sentAt: 'asc' } } },
    orderBy: { updatedAt: 'desc' },
    take: limit * 3, // overfetch; many will be filtered out below
  });

  const cases: EvalCase[] = [];
  for (const t of threads) {
    const inbound = t.messages.filter((m) => m.direction === 'INBOUND');
    const outbound = t.messages.filter((m) => m.direction === 'OUTBOUND');
    if (!inbound.length || !outbound.length) continue;

    // The last human-sent reply is the reference; the customer messages it was
    // answering are the inbound ones before it.
    const lastOut = outbound[outbound.length - 1];
    const priorInbound = inbound.filter((m) => m.sentAt <= lastOut.sentAt);
    if (!priorInbound.length) continue;

    const customerMessage = priorInbound
      .map((m) => latestReplyText({ subject: m.subject, bodyText: m.bodyText, bodyHtml: m.bodyHtml }))
      .join('\n\n---\n\n');
    const reference = latestReplyText({
      subject: lastOut.subject,
      bodyText: lastOut.bodyText,
      bodyHtml: lastOut.bodyHtml,
    });
    if (reference.trim().length < 15) continue; // skip auto/one-word replies

    cases.push({ threadId: t.id, subject: t.subject || '(no subject)', customerMessage, reference });
    if (cases.length >= limit) break;
  }

  console.log(`Evaluating ${cases.length} threads (last ${days} days)...\n`);

  const results: EvalResult[] = [];
  for (const c of cases) {
    try {
      const built = await buildThreadSuggestionContext(c.threadId, { forceFresh: false });
      if (!built) continue;
      const suggestion = await claude.generateSuggestion(built.context);
      if (!suggestion.draft || !suggestion.draft.trim()) continue; // no-reply intent
      const score = await claude.judgeDraft({
        customerMessage: c.customerMessage,
        draft: suggestion.draft,
        reference: c.reference,
      });
      results.push({ ...c, draft: suggestion.draft, score });
      console.log(
        `- ${(c.subject || '').slice(0, 50).padEnd(50)} ` +
          `aq=${score.addressesQuestion} fc=${score.factualConsistency} cm=${score.completeness} ` +
          `${score.pass ? 'PASS' : 'FAIL'} ${score.failureModes.join(',')}`
      );
    } catch (e) {
      console.error(`- ${c.subject}: error`, e instanceof Error ? e.message : e);
    }
  }

  const n = results.length || 1;
  const avg = (k: 'addressesQuestion' | 'factualConsistency' | 'completeness' | 'tone') =>
    +(results.reduce((s, r) => s + r.score[k], 0) / n).toFixed(2);
  const passRatePct = +((results.filter((r) => r.score.pass).length / n) * 100).toFixed(0);
  const failureModes: Record<string, number> = {};
  for (const r of results) for (const f of r.score.failureModes) failureModes[f] = (failureModes[f] || 0) + 1;

  const summary = {
    when: new Date().toISOString(),
    days,
    evaluated: results.length,
    avg: {
      addressesQuestion: avg('addressesQuestion'),
      factualConsistency: avg('factualConsistency'),
      completeness: avg('completeness'),
      tone: avg('tone'),
    },
    passRatePct,
    failureModes,
  };

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));

  const outDir = path.join(process.cwd(), 'eval-reports');
  mkdirSync(outDir, { recursive: true });
  const stamp = summary.when.slice(0, 19).replace(/[:T]/g, '-');
  writeFileSync(path.join(outDir, `eval-${stamp}.json`), JSON.stringify({ summary, results }, null, 2));

  const worst = results.filter((r) => !r.score.pass).slice(0, 10);
  const md = [
    `# Draft accuracy eval - ${summary.when}`,
    '',
    `Evaluated **${summary.evaluated}** threads (last ${days} days).`,
    '',
    `- Addresses question: **${summary.avg.addressesQuestion}/5**`,
    `- Factual consistency: **${summary.avg.factualConsistency}/5**`,
    `- Completeness: **${summary.avg.completeness}/5**`,
    `- Tone: **${summary.avg.tone}/5**`,
    `- Pass rate (all >=4, no failure mode): **${summary.passRatePct}%**`,
    '',
    '## Failure modes',
    ...Object.entries(failureModes)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Worst cases',
    ...worst.map(
      (r) =>
        `### ${r.subject}\n` +
        `- Flags: ${r.score.failureModes.join(', ') || 'low scores'} - ${r.score.note}\n` +
        `- Customer: ${r.customerMessage.replace(/\s+/g, ' ').slice(0, 240)}\n` +
        `- AI draft: ${r.draft.replace(/\s+/g, ' ').slice(0, 240)}\n` +
        `- Human sent: ${r.reference.replace(/\s+/g, ' ').slice(0, 240)}`
    ),
  ].join('\n');
  writeFileSync(path.join(outDir, `eval-${stamp}.md`), md);

  console.log(`\nReport written to eval-reports/eval-${stamp}.{json,md}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
