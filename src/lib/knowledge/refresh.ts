/**
 * Shopify knowledge refresh
 * Pulls the store's Online Store pages (FAQ, size guide, about, ...) and legal
 * policies (refund, shipping, ...) via the Admin API and upserts them as
 * KnowledgeSource rows. Runs on a slow worker loop - this content changes rarely.
 */

import prisma from '@/lib/db';
import { createShopifyClient } from '@/lib/shopify';

/** Strip HTML to readable plain text */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|li|h[1-6]|br)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export interface KnowledgeRefreshStats {
  pages: number;
  policies: number;
  collections: number;
  products: number;
  priceLines: number;
}

/**
 * Refresh Shopify pages + policies into KnowledgeSource. Existing rows are
 * upserted by key; removed/empty pages are not deleted (harmless, and avoids
 * clobbering during a transient API hiccup).
 */
export async function refreshShopifyKnowledge(): Promise<KnowledgeRefreshStats> {
  const stats: KnowledgeRefreshStats = { pages: 0, policies: 0, collections: 0, products: 0, priceLines: 0 };

  const shopify = await createShopifyClient();
  if (!shopify) return stats;

  const [pages, policies, origin, collections, products, priceLadders] = await Promise.all([
    shopify.getPages(50),
    shopify.getShopPolicies(),
    shopify.getPrimaryDomain(),
    shopify.getCollections(100),
    shopify.getActiveProducts(200),
    shopify.getPriceLadders(),
  ]);

  for (const page of pages) {
    const content = htmlToText(page.body || '');
    if (!content) continue;
    await prisma.knowledgeSource.upsert({
      where: { key: `page:${page.handle}` },
      create: {
        type: 'SHOPIFY_PAGE',
        key: `page:${page.handle}`,
        title: page.title,
        content,
        source: `https://${shopify.getStoreDomain()}/pages/${page.handle}`,
      },
      update: { title: page.title, content },
    });
    stats.pages++;
  }

  for (const policy of policies) {
    const content = htmlToText(policy.body || '');
    if (!content) continue;
    await prisma.knowledgeSource.upsert({
      where: { key: `policy:${policy.type}` },
      create: {
        type: 'SHOPIFY_POLICY',
        key: `policy:${policy.type}`,
        title: policy.title || policy.type,
        content,
        source: policy.url,
      },
      update: { title: policy.title || policy.type, content, source: policy.url },
    });
    stats.policies++;
  }

  // Price by size, per garment line. Our prices step up with size, and without
  // these real numbers the model was inventing the ladder in replies (it told a
  // customer sizes cost the same up to XL, which is true of nothing we sell).
  if (priceLadders.length > 0) {
    const lines = priceLadders.map((l) => {
      const ladder = l.ladder.map((s) => `${s.size} $${s.price}`).join(', ');
      const caveat =
        l.exceptions > 0
          ? ` (standard for this line; ${l.exceptions} of ${l.products} products are priced differently)`
          : '';
      return `- ${l.line}: ${ladder}${caveat}`;
    });
    const content =
      'LIST PRICE BY SIZE, per garment line, in USD, before any discount. ' +
      'These figures are pulled from the live store, so you MAY quote them.\n' +
      'Our prices DO step up with size on every adult garment. Never tell a customer ' +
      'that sizes cost the same, and never guess where the step starts - read it off this list.\n' +
      'This is the standard ladder for each line. Individual products can differ, so if a ' +
      'customer quotes a price they saw on a product page, the product page is right and they are ' +
      'not mistaken. When in doubt, point them to the product page rather than arguing a number.\n\n' +
      lines.join('\n');
    await prisma.knowledgeSource.upsert({
      where: { key: 'catalog:pricing' },
      create: {
        type: 'SHOPIFY_CATALOG',
        key: 'catalog:pricing',
        title: 'Price by Size (per garment line)',
        content,
        source: `${origin}/collections/all`,
      },
      update: { title: 'Price by Size (per garment line)', content, source: `${origin}/collections/all` },
    });
    stats.priceLines = priceLadders.length;
  }

  // Collections (Long Sleeves, Kids, Hoodies, ...) - full storefront URLs so
  // the model links accurately without inventing handles.
  if (collections.length > 0) {
    const content =
      `Link customers to these collection pages when they ask for a category.\n` +
      collections
        .map((c) => `- ${c.title}: ${origin}/collections/${c.handle}`)
        .join('\n');
    await prisma.knowledgeSource.upsert({
      where: { key: 'catalog:collections' },
      create: {
        type: 'SHOPIFY_CATALOG',
        key: 'catalog:collections',
        title: 'Store Collections',
        content,
        source: `${origin}/collections`,
      },
      update: { title: 'Store Collections', content, source: `${origin}/collections` },
    });
    stats.collections = collections.length;
  }

  // Active products - for linking a specific item the customer names.
  if (products.length > 0) {
    const content =
      `Active products and their links. Only link to products listed here.\n` +
      products
        .map(
          (p) =>
            `- ${p.title}${p.productType ? ` [${p.productType}]` : ''}: ${origin}/products/${p.handle}`
        )
        .join('\n');
    await prisma.knowledgeSource.upsert({
      where: { key: 'catalog:products' },
      create: {
        type: 'SHOPIFY_CATALOG',
        key: 'catalog:products',
        title: 'Store Products (active)',
        content,
        source: `${origin}/collections/all`,
      },
      update: { title: 'Store Products (active)', content, source: `${origin}/collections/all` },
    });
    stats.products = products.length;
  }

  return stats;
}
