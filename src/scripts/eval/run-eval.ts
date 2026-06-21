/**
 * Terminal command for the offline draft-accuracy eval. Thin wrapper over
 * runDraftEval(): parses flags, prints progress, writes JSON + Markdown reports
 * to ./eval-reports/. The same core runs weekly in the worker (emails the score).
 *
 * Usage (needs DB + ANTHROPIC_API_KEY in env):
 *   npx tsx src/scripts/eval/run-eval.ts --days 30 --limit 40
 *   npm run eval:drafts -- --days 30 --limit 40
 *
 * SCOPE: exercises the core drafting path (system prompt + assembled context +
 * clean messages -> draft), which is exactly what comprehension and prompt
 * changes affect. Treat the numbers as a comparable BASELINE for regression.
 */

import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import prisma from '@/lib/db';
import { runDraftEval } from '@/lib/eval/run-draft-eval';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main(): Promise<void> {
  const days = parseInt(arg('days', '30'), 10);
  const limit = parseInt(arg('limit', '40'), 10);

  const report = await runDraftEval({ days, limit, onProgress: (l) => console.log(l) });
  const { summary, results } = report;

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));

  const outDir = path.join(process.cwd(), 'eval-reports');
  mkdirSync(outDir, { recursive: true });
  const stamp = summary.when.slice(0, 19).replace(/[:T]/g, '-');
  writeFileSync(path.join(outDir, `eval-${stamp}.json`), JSON.stringify(report, null, 2));

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
    ...Object.entries(summary.failureModes)
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
