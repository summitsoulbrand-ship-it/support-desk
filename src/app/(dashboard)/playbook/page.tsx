/**
 * The support playbook - the human-readable rendering of the SAME rule
 * blocks the AI drafting brain runs on (brand-voice.ts) plus the operator
 * instructions box. Nothing here is hand-maintained: change a rule in
 * brand-voice.ts (or the Settings box) and this page updates on deploy,
 * so a VA and the AI can never learn two different rulebooks.
 */

import {
  COMPANY_IDENTITY,
  BRAND_VOICE_GUIDELINES,
  STORE_POLICY_FACTS,
  ISSUE_HANDLING_RULES,
} from '@/lib/claude/brand-voice';
import { getClaudeConfig } from '@/lib/claude';

export const dynamic = 'force-dynamic';

/** Render one rule block: '## X' lines become headings, '- ' lines bullets. */
function RuleBlock({ text }: { text: string }) {
  const lines = text.split('\n');
  const out: React.ReactNode[] = [];
  let bullets: string[] = [];
  let key = 0;

  const flush = () => {
    if (bullets.length > 0) {
      out.push(
        <ul key={key++} className="mb-4 list-disc space-y-2 pl-5">
          {bullets.map((b, i) => (
            <li key={i} className="text-sm leading-relaxed text-gray-700">
              {b}
            </li>
          ))}
        </ul>
      );
      bullets = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) {
      flush();
      out.push(
        <h3 key={key++} className="mb-2 mt-6 text-base font-semibold text-gray-900">
          {line.slice(3)}
        </h3>
      );
    } else if (line.startsWith('- ')) {
      bullets.push(line.slice(2));
    } else if (line.trim().startsWith('- ')) {
      // Indented sub-bullet - keep it in the flow as its own bullet
      bullets.push(line.trim().slice(2));
    } else if (line.trim()) {
      flush();
      out.push(
        <p key={key++} className="mb-3 text-sm leading-relaxed text-gray-700">
          {line}
        </p>
      );
    }
  }
  flush();
  return <>{out}</>;
}

export default async function PlaybookPage() {
  const config = await getClaudeConfig().catch(() => null);
  const operatorInstructions = config?.customPrompt?.trim();

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-bold text-gray-900">Support Playbook</h1>
      <p className="mt-2 text-sm text-gray-600">
        These are the exact rules the AI drafting assistant follows - rendered
        for humans. When a rule changes, it changes here and for the AI at the
        same time, so this page is always current. Read it top to bottom on
        your first day; come back whenever a situation feels unclear.
      </p>

      <div className="mt-6 rounded-lg border border-blue-200 bg-blue-50 p-4">
        <h2 className="text-base font-semibold text-blue-900">
          How to work a thread
        </h2>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-blue-900">
          <li>
            Read the customer&apos;s latest message first - the whole message,
            every question in it.
          </li>
          <li>
            Review the AI draft. Check the &quot;things to check&quot; warnings
            and, when in doubt, open &quot;What the AI saw&quot; to confirm it
            read the right order.
          </li>
          <li>
            Edit if needed, then send. If your reply trips a brand rule, a red
            box explains which one - fix it rather than sending anyway.
          </li>
          <li>
            If an orange banner suggests escalating (upset customer, wholesale,
            legal wording), click <b>Escalate to Pati</b> and move on. Escalating
            is always the right call when you are unsure - it is never a
            failure.
          </li>
          <li>
            Never promise anything you cannot see in the order context, and
            never invent a discount code, a date, or a tracking number.
          </li>
        </ol>
      </div>

      <section className="mt-8">
        <h2 className="border-b pb-2 text-lg font-bold text-gray-900">
          Who we are
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-gray-700">
          {COMPANY_IDENTITY}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="border-b pb-2 text-lg font-bold text-gray-900">
          Voice and tone
        </h2>
        <div className="mt-3">
          <RuleBlock text={BRAND_VOICE_GUIDELINES} />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="border-b pb-2 text-lg font-bold text-gray-900">
          Store policy facts
        </h2>
        <div className="mt-3">
          <RuleBlock text={STORE_POLICY_FACTS} />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="border-b pb-2 text-lg font-bold text-gray-900">
          Handling specific issues
        </h2>
        <div className="mt-3">
          <RuleBlock text={ISSUE_HANDLING_RULES} />
        </div>
      </section>

      {operatorInstructions && (
        <section className="mt-8">
          <h2 className="border-b pb-2 text-lg font-bold text-gray-900">
            Current operator instructions
          </h2>
          <p className="mt-2 text-xs text-gray-500">
            Set in Settings by an admin - these apply on top of everything
            above.
          </p>
          <div className="mt-3">
            <RuleBlock text={operatorInstructions} />
          </div>
        </section>
      )}
    </div>
  );
}
