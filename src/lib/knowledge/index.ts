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
   * Include the (large) active-product list. Collections are always included.
   * Only the social-comment path asks for it now: email drafts look up the
   * designs a customer names instead (src/lib/ai/product-lookup.ts), because
   * this list is cut to its first ~87 of 1,064 products and drafts told
   * customers live designs did not exist (2026-09-22).
   */
  includeProductCatalog?: boolean;
  /**
   * Leave out the legal pages (privacy policy, terms of service, accessibility
   * statement, data-sharing opt-out). Their first 2,000 characters answered
   * nothing a customer asks support and cost ~6,600 characters per email
   * draft.
   */
  skipLegalPages?: boolean;
}

/** The full catalog index the lookup reads - far too big for any prompt. */
export const CATALOG_INDEX_KEY = 'catalog:all-products';

const LEGAL_PAGES = new Set([
  'policy:PRIVACY_POLICY',
  'policy:TERMS_OF_SERVICE',
  'page:accessibility-statement',
  'page:data-sharing-opt-out',
]);

// Per-source character caps by type. Catalog lists get more room.
const PER_TYPE_CAP: Record<KnowledgeType, number> = {
  BRAND: 2500,
  AVATAR: 2500,
  CUSTOM: 2500,
  // Refund (2,191) and shipping (2,103) policies were cut mid-sentence at 2,000.
  SHOPIFY_POLICY: 2600,
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
    if (r.key === CATALOG_INDEX_KEY) return false;
    // The big product list is opt-in per request; collections always stay.
    if (r.key === 'catalog:products' && !options.includeProductCatalog) return false;
    if (options.skipLegalPages && LEGAL_PAGES.has(r.key)) return false;
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
