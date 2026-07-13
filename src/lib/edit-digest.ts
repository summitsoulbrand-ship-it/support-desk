/**
 * Weekly edit digest: what each operator changed in the AI drafts before
 * sending, emailed to Pati. This is the coaching loop for a VA - instead of
 * shadowing their sends, she reads a weekly summary of "the AI suggested X,
 * they sent Y" with the biggest rewrites quoted.
 *
 * Relies on suggestion_feedback rows, which since 2026-07-04 are only written
 * on REAL edits (whitespace/HTML-conversion noise is filtered at capture).
 * Rows from before that date are mostly formatting noise, so the digest
 * normalizes whitespace again before measuring - belt and suspenders.
 */

import prisma from '@/lib/db';
import { createOutboundEmailSender } from '@/lib/email';
import {
  summarizeEdits,
  renderInsightsHtml,
  renderInsightsText,
  type EditForInsights,
} from '@/lib/edit-digest-insights';

// ALL whitespace removed, not just collapsed: the composer's plain-text body
// joins paragraphs without a space ("Hi Kelly,\n\nI am" -> "Hi Kelly,I am"),
// so space-collapsed texts still mismatch at every paragraph boundary and the
// prefix/suffix ratio counted everything in between as a rewrite (the
// 2026-07-05 digest scored word-identical drafts "97% changed"). Reflowed
// whitespace is not a coaching signal, so it is dropped from the comparison.
const ws = (t: string) => t.replace(/\s+/g, '');

/** 0..1 rough edit distance via longest-common-prefix/suffix trimming - cheap
 *  and good enough to rank "tweak" vs "rewrite" without a diff dependency. */
function editRatio(a: string, b: string): number {
  const x = ws(a);
  const y = ws(b);
  if (x === y) return 0;
  const max = Math.max(x.length, y.length);
  if (max === 0) return 0;
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (
    s < x.length - p &&
    s < y.length - p &&
    x[x.length - 1 - s] === y[y.length - 1 - s]
  )
    s++;
  const changed = Math.max(x.length, y.length) - p - s;
  return Math.min(1, changed / max);
}

function escapeHtml(t: string): string {
  return t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function excerpt(t: string, n = 400): string {
  const clean = ws(t);
  return clean.length > n ? `${clean.slice(0, n)}...` : clean;
}

export interface EditDigestSummary {
  days: number;
  totalEdits: number;
  users: number;
}

/** Build and email the digest. Returns a small summary for logging. */
export async function runEditDigestAndEmail(opts?: {
  days?: number;
  toEmail?: string;
}): Promise<EditDigestSummary> {
  const days = opts?.days ?? 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await prisma.suggestionFeedback.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
  });

  // Real edits only (pre-2026-07-04 rows can still be formatting noise)
  const real = rows.filter((r) => ws(r.originalDraft) !== ws(r.editedDraft));

  const userIds = [...new Set(real.map((r) => r.userId))];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, email: true, role: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  const threads = await prisma.thread.findMany({
    where: { id: { in: [...new Set(real.map((r) => r.threadId))] } },
    select: { id: true, subject: true },
  });
  const subjectByThread = new Map(threads.map((t) => [t.id, t.subject]));

  const perUser = userIds.map((uid) => {
    const mine = real
      .filter((r) => r.userId === uid)
      .map((r) => ({ ...r, ratio: editRatio(r.originalDraft, r.editedDraft) }));
    const rewrites = mine.filter((m) => m.ratio > 0.3);
    return {
      user: userById.get(uid),
      edits: mine.length,
      rewrites: rewrites.length,
      biggest: mine.sort((a, b) => b.ratio - a.ratio).slice(0, 5),
    };
  });

  const summary: EditDigestSummary = {
    days,
    totalEdits: real.length,
    users: perUser.length,
  };
  if (real.length === 0) return summary; // clean week - stay silent

  // "What I noticed this week" - the plain-English synthesis that leads the
  // email. One cheap Claude call clusters the recurring corrections and splits
  // durable style patterns (3+ strikes) from one-off fact fixes. Fails soft:
  // if Claude is unconfigured or the call errors, the digest sends without it.
  const editsForInsights: EditForInsights[] = real.map((r) => ({
    subject: subjectByThread.get(r.threadId) || '(no subject)',
    tags: r.threadTags || [],
    originalDraft: r.originalDraft,
    editedDraft: r.editedDraft,
  }));
  const insights = await summarizeEdits(editsForInsights);
  const insightsHtml = insights ? renderInsightsHtml(insights) : '';
  const insightsText = insights ? `${renderInsightsText(insights)}\n\n` : '';

  const sections = perUser
    .sort((a, b) => b.edits - a.edits)
    .map((p) => {
      const who = escapeHtml(p.user?.name || p.user?.email || 'Unknown');
      const cases = p.biggest
        .map(
          (m) =>
            `<div style="margin:8px 0;padding:8px;border:1px solid #eee;border-radius:6px">` +
            `<b>${escapeHtml(subjectByThread.get(m.threadId) || '(no subject)')}</b>` +
            ` <span style="color:#999;font-size:11px">${Math.round(m.ratio * 100)}% changed</span>` +
            `<br><span style="color:#b45309;font-size:12px">AI: ${escapeHtml(excerpt(m.originalDraft))}</span>` +
            `<br><span style="color:#166534;font-size:12px">Sent: ${escapeHtml(excerpt(m.editedDraft))}</span>` +
            `</div>`
        )
        .join('');
      return (
        `<h3 style="margin-bottom:4px">${who} (${p.user?.role || '?'})</h3>` +
        `<p style="margin-top:0">${p.edits} edited draft${p.edits === 1 ? '' : 's'}, ` +
        `${p.rewrites} full rewrite${p.rewrites === 1 ? '' : 's'} (&gt;30% changed)</p>` +
        cases
      );
    })
    .join('');

  const to = opts?.toEmail || process.env.EVAL_EMAIL_TO || 'summitsoulbrand@gmail.com';
  const sender = await createOutboundEmailSender();
  if (!sender) return summary;
  try {
    await sender.sendMessage({
      to: [{ address: to }],
      fromName: 'Summit Soul',
      subject: `Draft edits this week - ${real.length} edit${real.length === 1 ? '' : 's'} by ${perUser.length} operator${perUser.length === 1 ? '' : 's'}`,
      bodyHtml:
        `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px">` +
        insightsHtml +
        `<h2 style="color:#2f4a2f">Weekly draft-edit digest</h2>` +
        `<p>What operators changed in the AI drafts before sending (last ${days} days). ` +
        `Recurring corrections are candidates for a new rule in brand-voice.ts.</p>` +
        sections +
        `</div>`,
      bodyText:
        insightsText +
        `Weekly draft-edit digest (last ${days} days): ${real.length} edits by ` +
        perUser
          .map((p) => `${p.user?.name || p.user?.email || '?'} (${p.edits})`)
          .join(', '),
    });
  } finally {
    await sender.disconnect().catch(() => undefined);
  }
  return summary;
}
