/**
 * Core of the offline draft-accuracy eval, as a reusable function so BOTH the
 * terminal command (src/scripts/eval/run-eval.ts) and the weekly worker job
 * call the exact same logic. See run-eval.ts for the rationale and scope.
 */

import prisma from '@/lib/db';
import { createClaudeService } from '@/lib/claude';
import { buildThreadSuggestionContext } from '@/lib/ai/context';
import { latestReplyText } from '@/lib/email/latest-reply';
import { createOutboundEmailSender } from '@/lib/email';
import { cacheSet } from '@/lib/cache';

// Persisted so the Settings card can show the latest score in-app, regardless
// of whether the email lands. Worker writes it; the status endpoint reads it.
export const EVAL_RESULT_KEY = 'eval:last-result';
export const EVAL_REQUEST_KEY = 'eval:run-requested';
// v2: the running flag is now heartbeated with a short TTL so a killed run
// (e.g. a worker redeploy mid-run) clears in ~2 min instead of being stuck.
// Bumping the key name also drops any orphaned v1 flag immediately.
export const EVAL_RUNNING_KEY = 'eval:running:v2';
export const EVAL_RUNNING_TTL_SECONDS = 120;

export interface StoredEvalResult {
  ranAt: string;
  summary: DraftEvalSummary;
  worst: Array<{ subject: string; failureModes: string[]; note: string }>;
}

type Judgement = Awaited<
  ReturnType<NonNullable<Awaited<ReturnType<typeof createClaudeService>>>['judgeDraft']>
>;

export interface DraftEvalCaseResult {
  threadId: string;
  subject: string;
  customerMessage: string;
  reference: string;
  draft: string;
  score: Judgement;
}

export interface DraftEvalSummary {
  when: string;
  days: number;
  evaluated: number;
  avg: {
    addressesQuestion: number;
    factualConsistency: number;
    completeness: number;
    tone: number;
  };
  passRatePct: number;
  failureModes: Record<string, number>;
}

export interface DraftEvalReport {
  summary: DraftEvalSummary;
  results: DraftEvalCaseResult[];
}

export interface RunDraftEvalOptions {
  days?: number;
  limit?: number;
  /** Optional progress sink (the CLI prints; the worker stays quiet). */
  onProgress?: (line: string) => void;
}

export async function runDraftEval(
  opts: RunDraftEvalOptions = {}
): Promise<DraftEvalReport> {
  const days = opts.days ?? 30;
  const limit = opts.limit ?? 40;
  const log = opts.onProgress ?? (() => {});
  const since = new Date(Date.now() - days * 86400 * 1000);

  const claude = await createClaudeService();
  if (!claude) throw new Error('Claude not configured (set ANTHROPIC_API_KEY).');

  // Pull a wide recent pool, then RANDOM-sample from it, so each run grades a
  // different mix of threads (Pati's ask) instead of always the same most-recent
  // set. Bigger pool = more variety; trade-off is a touch more run-to-run noise
  // in the headline, which the larger 120-sample button smooths out.
  const pool = await prisma.thread.findMany({
    where: {
      updatedAt: { gte: since },
      messages: { some: { direction: 'OUTBOUND' } },
    },
    include: { messages: { orderBy: { sentAt: 'asc' } } },
    orderBy: { updatedAt: 'desc' },
    take: Math.min(limit * 8, 600),
  });
  // Fisher-Yates shuffle (worker context - Math.random is fine here).
  const threads = [...pool];
  for (let i = threads.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [threads[i], threads[j]] = [threads[j], threads[i]];
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
    const reference = latestReplyText({
      subject: lastOut.subject,
      bodyText: lastOut.bodyText,
      bodyHtml: lastOut.bodyHtml,
    });
    if (reference.trim().length < 15) continue;

    cases.push({ threadId: t.id, subject: t.subject || '(no subject)', customerMessage, reference });
    if (cases.length >= limit) break;
  }

  log(`Evaluating ${cases.length} threads (last ${days} days)...`);

  const results: DraftEvalCaseResult[] = [];
  for (const c of cases) {
    try {
      const built = await buildThreadSuggestionContext(c.threadId, { forceFresh: false });
      if (!built) continue;
      const suggestion = await claude.generateSuggestion(built.context);
      if (!suggestion.draft || !suggestion.draft.trim()) continue;
      const score = await claude.judgeDraft({
        customerMessage: c.customerMessage,
        draft: suggestion.draft,
        reference: c.reference,
      });
      results.push({ ...c, draft: suggestion.draft, score });
      log(
        `- ${(c.subject || '').slice(0, 50).padEnd(50)} ` +
          `aq=${score.addressesQuestion} fc=${score.factualConsistency} cm=${score.completeness} ` +
          `${score.pass ? 'PASS' : 'FAIL'} ${score.failureModes.join(',')}`
      );
    } catch (e) {
      log(`- ${c.subject}: error ${e instanceof Error ? e.message : e}`);
    }
  }

  const n = results.length || 1;
  const avg = (k: 'addressesQuestion' | 'factualConsistency' | 'completeness' | 'tone') =>
    +(results.reduce((s, r) => s + r.score[k], 0) / n).toFixed(2);
  const passRatePct = +((results.filter((r) => r.score.pass).length / n) * 100).toFixed(0);
  const failureModes: Record<string, number> = {};
  for (const r of results) for (const f of r.score.failureModes) failureModes[f] = (failureModes[f] || 0) + 1;

  return {
    summary: {
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
    },
    results,
  };
}

/**
 * Run the eval and email the score to the admin (or a given address). Shared by
 * the weekly worker job and the on-demand admin trigger. Returns the summary;
 * if there's nothing to evaluate or no admin email, it skips the email.
 */
export async function runEvalAndEmail(opts: {
  days?: number;
  limit?: number;
  toEmail?: string;
  onProgress?: (line: string) => void;
}): Promise<DraftEvalSummary> {
  const report = await runDraftEval({
    days: opts.days,
    limit: opts.limit,
    onProgress: opts.onProgress,
  });
  const s = report.summary;

  // Persist for the in-app card FIRST, so the score is visible even if email
  // delivery fails. Keep only short fields (no customer bodies) in the cache.
  const stored: StoredEvalResult = {
    ranAt: s.when,
    summary: s,
    worst: report.results
      .filter((r) => !r.score.pass)
      .slice(0, 8)
      .map((r) => ({ subject: r.subject, failureModes: r.score.failureModes, note: r.score.note })),
  };
  await cacheSet(EVAL_RESULT_KEY, stored, 30 * 24 * 60 * 60); // 30 days

  if (s.evaluated === 0) return s;

  // Where the score email goes: an explicit recipient wins, else EVAL_EMAIL_TO,
  // else Pati's brand inbox (she wants the score there, not the support@ admin
  // account). Change without a code edit by setting EVAL_EMAIL_TO on the worker.
  const to = opts.toEmail || process.env.EVAL_EMAIL_TO || 'summitsoulbrand@gmail.com';
  if (!to) return s;

  const sender = await createOutboundEmailSender();
  if (!sender) return s;
  try {
    await sender.sendMessage({
      to: [{ address: to }],
      fromName: 'Summit Soul',
      subject: `AI draft accuracy - ${s.passRatePct}% pass (${s.evaluated} threads)`,
      bodyHtml: renderEvalEmailHtml(report),
      bodyText:
        `AI draft accuracy (last ${s.days} days, ${s.evaluated} threads):\n` +
        `Addresses question ${s.avg.addressesQuestion}/5, factual ${s.avg.factualConsistency}/5, ` +
        `completeness ${s.avg.completeness}/5, tone ${s.avg.tone}/5. Pass rate ${s.passRatePct}%.`,
    });
  } finally {
    await sender.disconnect().catch(() => undefined);
  }
  return s;
}

/** A short HTML email body summarizing a run (for the weekly job). */
export function renderEvalEmailHtml(report: DraftEvalReport): string {
  const s = report.summary;
  const fm = Object.entries(s.failureModes)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<li>${k}: ${v}</li>`)
    .join('');
  const worst = report.results
    .filter((r) => !r.score.pass)
    .slice(0, 5)
    .map(
      (r) =>
        `<div style="margin:8px 0;padding:8px;border:1px solid #eee;border-radius:6px">` +
        `<b>${escapeHtml(r.subject)}</b> - ${escapeHtml(r.score.failureModes.join(', ') || 'low scores')}` +
        `<br><span style="color:#666;font-size:12px">${escapeHtml(r.score.note)}</span></div>`
    )
    .join('');
  return (
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px">` +
    `<h2 style="color:#2f4a2f">AI draft accuracy - weekly</h2>` +
    `<p>Evaluated <b>${s.evaluated}</b> threads (last ${s.days} days).</p>` +
    `<ul>` +
    `<li>Addresses question: <b>${s.avg.addressesQuestion}/5</b></li>` +
    `<li>Factual consistency: <b>${s.avg.factualConsistency}/5</b></li>` +
    `<li>Completeness: <b>${s.avg.completeness}/5</b></li>` +
    `<li>Tone: <b>${s.avg.tone}/5</b></li>` +
    `<li>Pass rate: <b>${s.passRatePct}%</b></li>` +
    `</ul>` +
    (fm ? `<h3>Failure modes</h3><ul>${fm}</ul>` : '') +
    (worst ? `<h3>Worst cases</h3>${worst}` : '') +
    `<p style="color:#9aa893;font-size:12px">Automatic weekly run. Re-run anytime: npm run eval:drafts</p>` +
    `</div>`
  );
}

function escapeHtml(s: string): string {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
