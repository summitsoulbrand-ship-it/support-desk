/**
 * Shared machinery for self-service size/color swaps, used by BOTH the
 * item-change route (same-price and cheaper swaps apply immediately) and the
 * worker's payment watcher (pricier swaps apply once the balance is paid).
 *
 * Two halves:
 *  - mapPrintifySwap: deterministically pin the Printify line being changed
 *    and build the replacement line set verbatim (the #27253 protection).
 *  - applyPrintifySwap: cancel+recreate via the relink flow, then verify the
 *    replacement (product multiset + design affinity on the new label).
 */

import {
  recreatePrintifyOrder,
  labelTokens,
} from '@/lib/printify/relink';
import type { PrintifyClient } from '@/lib/printify';
import type { PrintifyOrder, PrintifyProduct } from '@/lib/printify/types';

/**
 * Loose design-title match ("Wanderlust Love" vs a Printify line's metadata
 * title) - the same affinity idea resolvePrintifyLineItems uses, kept
 * deliberately forgiving because titles differ slightly across platforms.
 */
export function titlesMatch(a: string, b: string): boolean {
  const words = (s: string) =>
    s.toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const aw = words(a);
  const bw = words(b);
  if (aw.length === 0 || bw.length === 0) return true; // nothing to compare
  const hits = aw.filter((h) =>
    bw.some((t) => t === h || t.startsWith(h.slice(0, 4)) || h.startsWith(t.slice(0, 4)))
  ).length;
  return hits >= Math.min(2, aw.length);
}

export interface SwapMapInput {
  /** Design title of the line being changed (Shopify line title) */
  itemTitle: string;
  /** CURRENT variant label of the line being changed (e.g. "Military Green / M") */
  oldVariantTitle: string;
  /** New variant label (e.g. "Military Green / L") */
  newVariantTitle: string;
  quantity: number;
}

export interface SwapMap {
  desiredLines: { product_id: string; variant_id: number; quantity: number }[];
}

/**
 * Deterministic Printify line mapping. Returns null when anything is
 * ambiguous or missing - the caller routes to support, never guesses.
 */
export async function mapPrintifySwap(
  printify: PrintifyClient,
  origCopy: PrintifyOrder,
  input: SwapMapInput
): Promise<SwapMap | null> {
  const prodCache = new Map<string, PrintifyProduct | null>();
  const getProd = async (id: string): Promise<PrintifyProduct | null> => {
    if (!prodCache.has(id)) {
      try {
        prodCache.set(id, await printify.getProduct(id));
      } catch {
        prodCache.set(id, null);
      }
    }
    return prodCache.get(id) ?? null;
  };

  // Every Printify line whose current variant label matches the OLD label is
  // a candidate; disambiguate by design-title affinity.
  const oldKey = labelTokens(input.oldVariantTitle || '');
  const candidates: {
    pli: PrintifyOrder['line_items'][number];
    prod: PrintifyProduct;
  }[] = [];
  for (const pli of origCopy.line_items) {
    const prod = await getProd(pli.product_id);
    const v = prod?.variants.find((pv) => pv.id === pli.variant_id);
    if (prod && v && labelTokens(v.title) === oldKey) {
      candidates.push({ pli, prod });
    }
  }
  const byTitle = candidates.filter((c) =>
    titlesMatch(input.itemTitle, c.pli.metadata?.title || c.prod.title || '')
  );
  const matched =
    byTitle.length === 1 ? byTitle[0] : candidates.length === 1 ? candidates[0] : null;
  if (!matched || matched.pli.quantity !== input.quantity) return null;

  // The new size/color must exist on the SAME Printify product.
  const newKey = labelTokens(input.newVariantTitle);
  const newPv =
    matched.prod.variants.find(
      (pv) => pv.is_enabled && labelTokens(pv.title) === newKey
    ) || matched.prod.variants.find((pv) => labelTokens(pv.title) === newKey);
  if (!newPv) return null;

  return {
    desiredLines: origCopy.line_items.map((pli) =>
      pli === matched.pli
        ? { product_id: pli.product_id, variant_id: newPv.id, quantity: pli.quantity }
        : { product_id: pli.product_id, variant_id: pli.variant_id, quantity: pli.quantity }
    ),
  };
}

export interface ApplySwapResult {
  success: boolean;
  newPrintifyOrderId?: string;
  /** Post-swap verification outcome (only meaningful when success) */
  verified: boolean;
  inProduction?: boolean;
  error?: string;
}

/**
 * Cancel+recreate the Printify copy with the mapped line set, then verify:
 *  a) product multiset unchanged (a mislanded swap moves a line to a
 *     different design and breaks this) - free, no API calls;
 *  b) some replacement line carries the NEW variant label AND belongs to the
 *     changed line's design (metadata title affinity) - lesson #27253.
 */
export async function applyPrintifySwap(
  printify: PrintifyClient,
  args: {
    printifyOrderId: string;
    origCopy: PrintifyOrder;
    shopifyOrderId: string;
    shopifyOrderName: string;
    map: SwapMap;
    itemTitle: string;
    newVariantTitle: string;
  }
): Promise<ApplySwapResult> {
  let result: Awaited<ReturnType<typeof recreatePrintifyOrder>>;
  try {
    result = await recreatePrintifyOrder({
      printifyOrderId: args.printifyOrderId,
      shopifyOrderId: args.shopifyOrderId,
      shopifyOrderName: args.shopifyOrderName,
      reason: 'ITEM_CHANGE',
      lineItems: args.map.desiredLines,
    });
  } catch (err) {
    result = {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
  if (!result.success || !result.newPrintifyOrderId) {
    return {
      success: false,
      verified: false,
      inProduction: result.inProduction,
      error: result.error,
    };
  }
  const newPrintifyOrderId = result.newPrintifyOrderId;

  let verified = false;
  try {
    const created = await printify.getOrder(newPrintifyOrderId);
    if (created) {
      const productKey = (o: { line_items: { product_id: string; quantity: number }[] }) =>
        o.line_items
          .flatMap((li) => Array(li.quantity).fill(li.product_id))
          .sort()
          .join(',');
      const sameProducts = productKey(created) === productKey(args.origCopy);

      let labelOnRightDesign = false;
      const want = labelTokens(args.newVariantTitle);
      for (const li of created.line_items) {
        const prod = await printify.getProduct(li.product_id);
        const v = prod?.variants.find((pv) => pv.id === li.variant_id);
        if (!v || labelTokens(v.title) !== want) continue;
        const liTitle = li.metadata?.title || prod?.title || '';
        if (titlesMatch(args.itemTitle, liTitle)) {
          labelOnRightDesign = true;
          break;
        }
      }
      verified = sameProducts && labelOnRightDesign;
    }
  } catch {
    verified = false;
  }

  return { success: true, newPrintifyOrderId, verified };
}
