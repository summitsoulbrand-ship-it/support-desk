/**
 * Store knowledge
 * Brand voice + customer avatar (pushed from the Summit Soul AI project), the
 * store's own Shopify pages + policies, and the catalog (collections +
 * products with links), all pulled by the worker. Injected into AI reply
 * drafts so the model answers policy/FAQ/sizing questions and links to the
 * right products/collections instead of guessing.
 */

import prisma from '@/lib/db';
import type { KnowledgeType } from '@prisma/client';

export interface KnowledgeBlock {
  title: string;
  content: string;
}

export interface KnowledgeOptions {
  /**
   * Include the (large) active-product list. Collections are always included;
   * the full product catalog is only worth its tokens for product/availability
   * questions, so callers pass true for those.
   */
  includeProductCatalog?: boolean;
}

// Per-source character caps by type. Catalog lists get more room.
const PER_TYPE_CAP: Record<KnowledgeType, number> = {
  BRAND: 2500,
  AVATAR: 2500,
  CUSTOM: 2500,
  SHOPIFY_POLICY: 2000,
  SHOPIFY_PAGE: 2000,
  SHOPIFY_CATALOG: 9000,
};

// Most-relevant-first so the reader stays readable; catalog last.
const TYPE_ORDER: KnowledgeType[] = [
  'BRAND',
  'AVATAR',
  'SHOPIFY_POLICY',
  'CUSTOM',
  'SHOPIFY_PAGE',
  'SHOPIFY_CATALOG',
];

/**
 * Load enabled knowledge sources, ordered and per-source capped, ready to
 * inject into a draft prompt. Returns [] when nothing is configured.
 */
export async function getKnowledgeBlocks(
  options: KnowledgeOptions = {}
): Promise<KnowledgeBlock[]> {
  const rows = await prisma.knowledgeSource.findMany({
    where: { enabled: true },
  });
  if (rows.length === 0) return [];

  const filtered = rows.filter((r) => {
    // The big product list is opt-in per request; collections always stay.
    if (r.key === 'catalog:products' && !options.includeProductCatalog) return false;
    return true;
  });

  filtered.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));

  return filtered.map((row) => {
    const cap = PER_TYPE_CAP[row.type] ?? 2500;
    let content = row.content.trim();
    if (content.length > cap) {
      content = content.slice(0, cap) + '\n...(truncated)';
    }
    return { title: row.title, content };
  });
}
