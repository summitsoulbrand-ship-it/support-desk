/**
 * Store knowledge for social replies: brand voice, policies, pages and
 * collection links (no full product catalog - comments do not need 200
 * products of tokens). Cached per process for an hour.
 */

import { getKnowledgeBlocks } from '@/lib/knowledge';

let cached: { at: number; text: string } | null = null;

export async function getSocialKnowledgeText(): Promise<string> {
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.text;
  try {
    const blocks = await getKnowledgeBlocks();
    if (blocks.length === 0) return '';
    let text = '\n\n## Store Knowledge (use this to answer accurately)\n';
    text +=
      'When a question matches a collection or page below, include the link in the reply. Never invent links or facts not listed here.\n\n';
    for (const b of blocks) {
      text += `### ${b.title}\n${b.content}\n\n`;
    }
    cached = { at: Date.now(), text };
    return text;
  } catch {
    return cached?.text || '';
  }
}
