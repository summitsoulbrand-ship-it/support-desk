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
}

/**
 * Refresh Shopify pages + policies into KnowledgeSource. Existing rows are
 * upserted by key; removed/empty pages are not deleted (harmless, and avoids
 * clobbering during a transient API hiccup).
 */
export async function refreshShopifyKnowledge(): Promise<KnowledgeRefreshStats> {
  const stats: KnowledgeRefreshStats = { pages: 0, policies: 0 };

  const shopify = await createShopifyClient();
  if (!shopify) return stats;

  const [pages, policies] = await Promise.all([
    shopify.getPages(50),
    shopify.getShopPolicies(),
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

  return stats;
}
