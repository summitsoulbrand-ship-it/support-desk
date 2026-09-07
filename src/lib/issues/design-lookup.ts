/**
 * Which designs a complaining customer actually owns.
 *
 * Customers name a design about half the time ("the frog shirt is peeling").
 * The other half just say "my shirt", and a report that cannot say WHICH
 * design is failing is useless for fixing anything. So before the analysis
 * asks Claude what the complaint is, it hands it the designs that customer
 * bought, and the model picks from that list.
 *
 * This reads the LOCAL Printify order cache rather than calling Shopify: the
 * cache is synced every ten minutes, holds six months of orders (which covers
 * every complaint that is still live), and a local query costs nothing. The
 * order-number path uses the indexed label columns; the email path uses the
 * expression index added alongside the customer_issues table.
 *
 * Titles come back reduced to their design base ("Frog Wizard Kerfuffle
 * Premium" -> "Frog Wizard Kerfuffle") so the same artwork on a hoodie, a
 * toddler tee and a Premium groups as one design in the report.
 */

import prisma from '@/lib/db';
import { designBaseTitle } from '@/lib/ai/design-versions';
import type { PrintifyOrder } from '@/lib/printify/types';

/** How far back a complaint's order can plausibly sit. */
const LOOKBACK_DAYS = 180;
/** More than this and the list stops helping the model choose. */
const MAX_DESIGNS = 10;

const isCancelled = (status: unknown): boolean =>
  /^cancell?ed$/i.test(String(status || ''));

/** Every design base title on an order, de-duplicated, order preserved. */
function designsOnOrder(order: PrintifyOrder | null | undefined): string[] {
  if (!order?.line_items) return [];
  const out: string[] = [];
  for (const item of order.line_items) {
    const title = item.metadata?.title?.trim();
    if (!title) continue;
    const base = designBaseTitle(title);
    if (base && !out.includes(base)) out.push(base);
  }
  return out;
}

/** The order-number spellings the cache might have stored. */
function labelCandidates(orderNumber: string): string[] {
  const raw = orderNumber.trim();
  const bare = raw.replace(/^#/, '');
  return Array.from(new Set([raw, bare, `#${bare}`])).filter(Boolean);
}

/**
 * Designs on one named order. A rebuilt order (upsell merge, address or size
 * change, the combiner) leaves CANCELLED copies behind under the same order
 * name, and the dead copy is sometimes the freshest row - so a live copy wins
 * over a cancelled one regardless of which was updated last.
 */
async function designsByOrderNumber(orderNumber: string): Promise<string[]> {
  const candidates = labelCandidates(orderNumber);
  const rows = await prisma.printifyOrderCache.findMany({
    where: {
      OR: [
        { externalId: { in: candidates } },
        { label: { in: candidates } },
        { metadataShopOrderId: { in: candidates } },
        { metadataShopOrderLabel: { in: candidates } },
      ],
    },
    orderBy: { updatedAt: 'desc' },
    take: 10,
  });
  const live = rows.find((r) => !isCancelled(r.status)) ?? rows[0] ?? null;
  return designsOnOrder(live?.data as unknown as PrintifyOrder | undefined);
}

/**
 * Designs across a customer's recent orders, newest order first.
 *
 * Sorted in JS on the order's own created_at rather than in SQL: the cache row
 * timestamps record when the sync wrote the row, so a backfilled six-month
 * sweep stamps ancient orders as brand new. The email equality filter narrows
 * to one person's handful of orders first, so the sort is over nothing.
 */
async function designsByEmail(email: string): Promise<string[]> {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const rows = await prisma.$queryRaw<{ data: unknown; status: string }[]>`
    SELECT "data", "status"
    FROM "printify_orders"
    WHERE lower("data" -> 'address_to' ->> 'email') = ${email.toLowerCase()}
    LIMIT 40
  `;

  const orders = rows
    .filter((r) => !isCancelled(r.status))
    .map((r) => r.data as PrintifyOrder)
    .filter((o) => o?.created_at && new Date(o.created_at) >= cutoff)
    .sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
    .slice(0, 6);

  const out: string[] = [];
  for (const order of orders) {
    for (const design of designsOnOrder(order)) {
      if (!out.includes(design)) out.push(design);
    }
  }
  return out;
}

/**
 * The designs this customer plausibly means, best guess first. Returns an
 * empty list rather than throwing - a lookup failure should cost the report a
 * design name, never the whole run.
 */
export async function designsForCustomer(opts: {
  email: string;
  orderNumber?: string | null;
}): Promise<string[]> {
  const designs: string[] = [];

  if (opts.orderNumber) {
    try {
      designs.push(...(await designsByOrderNumber(opts.orderNumber)));
    } catch (err) {
      console.error('[issues] design lookup by order number failed:', err);
    }
  }

  if (designs.length < MAX_DESIGNS && opts.email) {
    try {
      for (const design of await designsByEmail(opts.email)) {
        if (!designs.includes(design)) designs.push(design);
      }
    } catch (err) {
      console.error('[issues] design lookup by email failed:', err);
    }
  }

  return designs.slice(0, MAX_DESIGNS);
}

export const __testing = { designsOnOrder, labelCandidates };
