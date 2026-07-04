/**
 * The support playbook - the human-readable rendering of the SAME rule
 * blocks the AI drafting brain runs on (brand-voice.ts) plus the operator
 * instructions box. Nothing here is hand-maintained: change a rule in
 * brand-voice.ts (or the Settings box) and this page updates on deploy,
 * so a VA and the AI can never learn two different rulebooks.
 *
 * Parsing happens here on the server; playbook-view.tsx adds search and
 * navigation on the client.
 */

import {
  COMPANY_IDENTITY,
  BRAND_VOICE_GUIDELINES,
  STORE_POLICY_FACTS,
  ISSUE_HANDLING_RULES,
} from '@/lib/claude/brand-voice';
import { getClaudeConfig } from '@/lib/claude';
import {
  PlaybookView,
  type PlaybookSection,
  type RuleGroup,
} from '@/components/playbook-view';

export const dynamic = 'force-dynamic';

/**
 * Parse a rule block into themed groups: '##'/'###' lines become group
 * headings, '- ' lines become rules, indented '- ' lines nest under the rule
 * above. skipLeadingTitle drops a block's own '## Title' first line (the
 * page section already names it); ISSUE_HANDLING_RULES starts with a REAL
 * group heading, so it keeps its first line.
 */
function parseBlock(text: string, opts?: { skipLeadingTitle?: boolean }): RuleGroup[] {
  const groups: RuleGroup[] = [];
  let cur: RuleGroup = { heading: null, items: [] };
  let seenAnything = false;

  const push = () => {
    if (cur.items.length > 0) groups.push(cur);
  };

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const heading = line.match(/^#{2,3} (.+)$/);
    if (heading) {
      if (!seenAnything && opts?.skipLeadingTitle && line.startsWith('## ')) {
        seenAnything = true;
        continue;
      }
      seenAnything = true;
      push();
      cur = { heading: heading[1], items: [] };
    } else if (line.startsWith('- ')) {
      seenAnything = true;
      cur.items.push({ text: line.slice(2), subs: [] });
    } else if (line.trim().startsWith('- ') && cur.items.length > 0) {
      // Indented sub-bullet nests under the rule above
      cur.items[cur.items.length - 1].subs.push(line.trim().slice(2));
    } else if (cur.items.length > 0) {
      // Continuation line of the previous rule
      cur.items[cur.items.length - 1].text += ` ${line.trim()}`;
    } else {
      seenAnything = true;
      cur.items.push({ text: line.trim(), subs: [] });
    }
  }
  push();
  return groups;
}

export default async function PlaybookPage() {
  const config = await getClaudeConfig().catch(() => null);
  const operatorInstructions = config?.customPrompt?.trim();

  const sections: PlaybookSection[] = [
    {
      id: 'workflow',
      title: 'How to work a thread',
      ordered: [
        "Read the customer's latest message first - the whole message, every question in it.",
        'Review the AI draft. Check the "things to check" warnings and, when in doubt, open "What the AI saw" to confirm it read the right order.',
        'Edit if needed, then send. If your reply trips a brand rule, a red box explains which one - fix it rather than sending anyway.',
        'If an orange banner suggests escalating (upset customer, wholesale, legal wording), click Escalate to Pati and move on. Escalating is always the right call when you are unsure - it is never a failure.',
        'Never promise anything you cannot see in the order context, and never invent a discount code, a date, or a tracking number.',
      ],
    },
    {
      id: 'identity',
      title: 'Who we are',
      paragraph: COMPANY_IDENTITY,
    },
    {
      id: 'voice',
      title: 'Voice and tone',
      groups: parseBlock(BRAND_VOICE_GUIDELINES, { skipLeadingTitle: true }),
    },
    {
      id: 'policy',
      title: 'Store policy facts',
      note: 'Use these, never contradict them.',
      groups: parseBlock(STORE_POLICY_FACTS, { skipLeadingTitle: true }),
    },
    {
      id: 'issues',
      title: 'Handling specific issues',
      groups: parseBlock(ISSUE_HANDLING_RULES),
    },
  ];

  if (operatorInstructions) {
    sections.push({
      id: 'operator',
      title: 'Current operator instructions',
      note: 'Set in Settings by an admin - these apply on top of everything above.',
      groups: parseBlock(operatorInstructions),
    });
  }

  return <PlaybookView sections={sections} />;
}
