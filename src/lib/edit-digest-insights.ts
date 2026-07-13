/**
 * "What I noticed this week" - the synthesis layer on top of the raw weekly
 * edit digest. The digest itself lists the biggest AI-draft-vs-sent rewrites
 * grouped by operator; useful for coaching, but it is a pile of diffs with no
 * interpretation. This module makes ONE cheap Claude call over the week's real
 * edits and returns a short, plain-English read:
 *
 *   - observations: 3-5 plain sentences on what got changed repeatedly
 *   - candidateRules: STYLE patterns (tone, greeting, length, a phrase) that
 *     showed up in 3+ different emails - candidates for a brand-voice.ts rule.
 *     Three strikes, because people edit single emails for one-off reasons.
 *   - factChecks: FACTUAL corrections (a price, date, link, policy, name) -
 *     surfaced even at one occurrence, because a wrong fact is just wrong and
 *     does not need to repeat to matter.
 *
 * Deliberately "simple brain": one forced-tool call, no storage, no scoring
 * loop. It degrades to null (digest sends without the section) whenever Claude
 * is not configured or the call fails. It never proposes editing anything on
 * its own - every candidate is Pati's call to accept.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getClaudeConfig } from '@/lib/claude';

// Weekly synthesis is not latency-sensitive and runs over a whole week of
// edits at once, so the cheap fast model is the right tool.
const INSIGHTS_MODEL = 'claude-haiku-4-5-20251001';

// Keep the prompt bounded regardless of a heavy edit week.
const MAX_EDITS = 60;
const MAX_EXCERPT = 600;

export interface EditForInsights {
  subject: string;
  tags: string[];
  originalDraft: string;
  editedDraft: string;
}

export interface CandidateRule {
  /** Plain-English description of the recurring style change. */
  pattern: string;
  /** How many different emails this showed up in (>= 3 to qualify). */
  times: number;
}

export interface EditInsights {
  observations: string[];
  candidateRules: CandidateRule[];
  factChecks: string[];
}

const clip = (t: string) => {
  const s = t.replace(/\s+/g, ' ').trim();
  return s.length > MAX_EXCERPT ? `${s.slice(0, MAX_EXCERPT)}...` : s;
};

const SUMMARIZE_TOOL: Anthropic.Tool = {
  name: 'report_edit_patterns',
  description:
    'Report what the operator changed repeatedly when editing AI-drafted ' +
    'customer-service replies before sending them.',
  input_schema: {
    type: 'object',
    properties: {
      observations: {
        type: 'array',
        maxItems: 5,
        description:
          '3-5 short, plain-English sentences on what got changed most often ' +
          'this week. Written to a non-technical shop owner. No jargon. Plain ' +
          'hyphens only, never an em dash. Empty array if nothing stands out.',
        items: { type: 'string' },
      },
      candidate_rules: {
        type: 'array',
        description:
          'STYLE patterns (tone, greeting, sign-off, length, a recurring ' +
          'phrase or word swap) that appear in 3 OR MORE different emails. ' +
          'These are candidates for a permanent brand-voice rule. Do NOT ' +
          'include anything that appears in fewer than 3 emails - one-off ' +
          'edits are not rules. Empty array if none reached 3.',
        items: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description:
                'The recurring style change, e.g. "drops the opening ' +
                '\'I hope this finds you well\' line" or "shortens the ' +
                'closing to just \'Thanks, Pati\'".',
            },
            times: {
              type: 'integer',
              description:
                'Number of different emails this change appeared in (>= 3).',
            },
          },
          required: ['pattern', 'times'],
        },
      },
      fact_checks: {
        type: 'array',
        description:
          'FACTUAL corrections the operator made - a price, a date, a ' +
          'shipping time, a link, a policy, a product detail, or a name that ' +
          'the AI got wrong and the operator fixed. Include these even if ' +
          'they happened only once. Each entry: what the AI said vs what the ' +
          'operator corrected it to, in one plain sentence. Empty array if ' +
          'none.',
        items: { type: 'string' },
      },
    },
    required: ['observations', 'candidate_rules', 'fact_checks'],
  },
};

/**
 * Summarize a week of real draft edits into a short "what I noticed" read.
 * Returns null when Claude is not configured, there is nothing to summarize,
 * or the call fails - the caller then sends the plain digest without a
 * synthesis section.
 */
export async function summarizeEdits(
  edits: EditForInsights[]
): Promise<EditInsights | null> {
  if (edits.length === 0) return null;

  const config = await getClaudeConfig();
  if (!config) return null;

  const sample = edits.slice(0, MAX_EDITS);
  const body = sample
    .map((e, i) => {
      const tags = e.tags.length ? ` [${e.tags.join(', ')}]` : '';
      return (
        `--- Edit ${i + 1}${tags} (subject: ${e.subject})\n` +
        `AI drafted: ${clip(e.originalDraft)}\n` +
        `Operator sent: ${clip(e.editedDraft)}`
      );
    })
    .join('\n\n');

  const truncatedNote =
    edits.length > sample.length
      ? `\n\n(Showing the first ${sample.length} of ${edits.length} edits this week.)`
      : '';

  const userMessage =
    `Here are the edits an operator made to AI-drafted replies for a ` +
    `made-to-order apparel store (Summit Soul) before sending them this ` +
    `week. For each, you see what the AI drafted and what the operator ` +
    `actually sent. Find the patterns: what does the operator change again ` +
    `and again? Separate durable STYLE preferences (only report when seen in ` +
    `3+ emails) from one-off FACT corrections (report even once). Ignore pure ` +
    `whitespace or formatting differences.${truncatedNote}\n\n${body}`;

  try {
    const client = new Anthropic({ apiKey: config.apiKey });
    const response = await client.messages.create(
      {
        model: INSIGHTS_MODEL,
        max_tokens: 1024,
        tools: [SUMMARIZE_TOOL],
        tool_choice: { type: 'tool', name: 'report_edit_patterns' },
        messages: [{ role: 'user', content: userMessage }],
      },
      config.projectId
        ? { headers: { 'anthropic-project': config.projectId } }
        : undefined
    );

    const toolUse = response.content.find(
      (c): c is Anthropic.ToolUseBlock => c.type === 'tool_use'
    );
    if (!toolUse) return null;

    return normalizeInsights(toolUse.input);
  } catch (err) {
    console.error('[edit-digest] insights synthesis failed:', err);
    return null;
  }
}

/**
 * Validate and clean the model's tool output into EditInsights, or null when
 * nothing survives. Pure - separated from the API call so the guards (the
 * 3-strikes floor on style rules; facts kept at any count) are unit-testable.
 */
export function normalizeInsights(input: unknown): EditInsights | null {
  const raw = (input || {}) as {
    observations?: unknown;
    candidate_rules?: unknown;
    fact_checks?: unknown;
  };

  const strings = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      : [];

  const observations = strings(raw.observations).slice(0, 5);

  // Belt-and-suspenders: enforce the 3-strikes floor even if the model reports
  // a style pattern with a lower count. One-off edits are not rules.
  const candidateRules = (Array.isArray(raw.candidate_rules)
    ? raw.candidate_rules
    : []
  )
    .map((r) => r as { pattern?: unknown; times?: unknown })
    .filter(
      (r): r is { pattern: string; times: number } =>
        !!r &&
        typeof r.pattern === 'string' &&
        r.pattern.trim().length > 0 &&
        typeof r.times === 'number' &&
        r.times >= 3
    )
    .map((r) => ({ pattern: r.pattern.trim(), times: r.times }));

  const factChecks = strings(raw.fact_checks).slice(0, 10);

  if (
    observations.length === 0 &&
    candidateRules.length === 0 &&
    factChecks.length === 0
  ) {
    return null;
  }

  return { observations, candidateRules, factChecks };
}

/** Render the synthesis as the HTML block that leads the digest email. */
export function renderInsightsHtml(insights: EditInsights): string {
  const esc = (t: string) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const list = (items: string[]) =>
    `<ul style="margin:4px 0 12px;padding-left:20px">` +
    items.map((i) => `<li style="margin:3px 0">${esc(i)}</li>`).join('') +
    `</ul>`;

  let html =
    `<div style="margin:0 0 20px;padding:14px 16px;background:#f2f7f2;` +
    `border:1px solid #d8e6d8;border-radius:8px">` +
    `<h2 style="margin:0 0 8px;color:#2f4a2f">What I noticed this week</h2>`;

  if (insights.observations.length) {
    html += list(insights.observations);
  }

  if (insights.candidateRules.length) {
    html +=
      `<p style="margin:8px 0 4px"><b>Worth making a rule</b> ` +
      `<span style="color:#777;font-size:12px">(same change seen 3+ times - ` +
      `your call to accept)</span></p>` +
      `<ul style="margin:4px 0 12px;padding-left:20px">` +
      insights.candidateRules
        .map(
          (r) =>
            `<li style="margin:3px 0">${esc(r.pattern)} ` +
            `<span style="color:#777;font-size:12px">(${r.times} times)</span></li>`
        )
        .join('') +
      `</ul>`;
  }

  if (insights.factChecks.length) {
    html +=
      `<p style="margin:8px 0 4px"><b>Facts to double-check</b> ` +
      `<span style="color:#777;font-size:12px">(the AI may have these wrong - ` +
      `fix once and they stick)</span></p>` +
      list(insights.factChecks);
  }

  html += `</div>`;
  return html;
}

/** Render the synthesis as the plain-text lead for the digest email. */
export function renderInsightsText(insights: EditInsights): string {
  const lines: string[] = ['What I noticed this week:'];
  for (const o of insights.observations) lines.push(`- ${o}`);
  if (insights.candidateRules.length) {
    lines.push('', 'Worth making a rule (seen 3+ times, your call):');
    for (const r of insights.candidateRules)
      lines.push(`- ${r.pattern} (${r.times} times)`);
  }
  if (insights.factChecks.length) {
    lines.push('', 'Facts to double-check (fix once and they stick):');
    for (const f of insights.factChecks) lines.push(`- ${f}`);
  }
  return lines.join('\n');
}
