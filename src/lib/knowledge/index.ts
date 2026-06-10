/**
 * Store knowledge
 * Brand voice + customer avatar (pushed from the Summit Soul AI project) and
 * the store's own Shopify pages + policies (pulled by the worker). Injected
 * into AI reply drafts so the model answers policy/FAQ/sizing questions from
 * the store's actual published content instead of guessing.
 */

import prisma from '@/lib/db';
import type { KnowledgeType } from '@prisma/client';

export interface KnowledgeBlock {
  title: string;
  content: string;
}

// Per-source and total character budgets keep prompt cost bounded.
const PER_SOURCE_MAX = parseInt(process.env.KNOWLEDGE_PER_SOURCE_CHARS || '2500', 10);
const TOTAL_MAX = parseInt(process.env.KNOWLEDGE_TOTAL_CHARS || '9000', 10);

// Most-relevant-first so truncation drops the least important content.
const TYPE_ORDER: KnowledgeType[] = [
  'BRAND',
  'AVATAR',
  'SHOPIFY_POLICY',
  'CUSTOM',
  'SHOPIFY_PAGE',
];

/**
 * Load enabled knowledge sources, ordered and budget-capped, ready to inject
 * into a draft prompt. Returns [] when nothing is configured.
 */
export async function getKnowledgeBlocks(): Promise<KnowledgeBlock[]> {
  const rows = await prisma.knowledgeSource.findMany({
    where: { enabled: true },
  });
  if (rows.length === 0) return [];

  rows.sort(
    (a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)
  );

  const blocks: KnowledgeBlock[] = [];
  let budget = TOTAL_MAX;

  for (const row of rows) {
    if (budget <= 0) break;
    const cap = Math.min(PER_SOURCE_MAX, budget);
    let content = row.content.trim();
    if (content.length > cap) {
      content = content.slice(0, cap) + '\n...(truncated)';
    }
    blocks.push({ title: row.title, content });
    budget -= content.length;
  }

  return blocks;
}
