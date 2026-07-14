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

/**
 * One line change in a (possibly multi-item) batch. This is exactly what a
 * parked pricier batch stores in PendingItemChange.changes, so the payment
 * watcher can re-apply or revert the whole batch. All fields come from
 * Shopify's own numbers at request time.
 */
export interface BatchLineChange {
  lineItemId: string; // ORIGINAL Shopify line gid (removed by the edit)
  itemTitle: string;
  oldVariantId: string; // Shopify variant gid
  oldVariantTitle: string;
  oldUnitFull: string; // original catalog unit price
  removedPaid: string; // what the customer paid for this line
  newVariantId: string; // Shopify variant gid
  newVariantTitle: string;
  quantity: number;
  absorb: string; // per-line discount that preserves original pricing
}

/** Printify-mapping inputs for a batch (design title + old/new labels). */
export function toSwapInputs(changes: BatchLineChange[]): SwapMapInput[] {
  return changes.map((c) => ({
    itemTitle: c.itemTitle,
    oldVariantTitle: c.oldVariantTitle,
    newVariantTitle: c.newVariantTitle,
    quantity: c.quantity,
  }));
}

export interface SwapMap {
  desiredLines: { product_id: string; variant_id: number; quantity: number }[];
  /** The changes this map applies (for post-recreate verification). */
  changed: { itemTitle: string; newVariantTitle: string }[];
}

/**
 * Deterministic Printify line mapping for ONE OR MORE simultaneous changes.
 *
 * Each change is pinned to a DISTINCT Printify line (matched by old variant
 * label + design-title affinity, greedily, in order); a line claimed by one
 * change can't be claimed by another. Unchanged lines are copied verbatim.
 * Returns null on any ambiguity or miss - the caller routes to support and
 * never guesses (fail closed, exactly like the single-change path).
 */
export async function mapPrintifySwap(
  printify: PrintifyClient,
  origCopy: PrintifyOrder,
  input: SwapMapInput | SwapMapInput[]
): Promise<SwapMap | null> {
  const changes = Array.isArray(input) ? input : [input];
  if (changes.length === 0) return null;

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

  const claimed = new Set<number>(); // origCopy line indices already assigned
  const newVariantByIndex = new Map<number, number>();

  for (const change of changes) {
    const oldKey = labelTokens(change.oldVariantTitle || '');
    // Unclaimed lines whose CURRENT label matches this change's old label.
    const candidates: {
      idx: number;
      pli: PrintifyOrder['line_items'][number];
      prod: PrintifyProduct;
    }[] = [];
    for (let i = 0; i < origCopy.line_items.length; i++) {
      if (claimed.has(i)) continue;
      const pli = origCopy.line_items[i];
      const prod = await getProd(pli.product_id);
      const v = prod?.variants.find((pv) => pv.id === pli.variant_id);
      if (prod && v && labelTokens(v.title) === oldKey) {
        candidates.push({ idx: i, pli, prod });
      }
    }
    const byTitle = candidates.filter((c) =>
      titlesMatch(change.itemTitle, c.pli.metadata?.title || c.prod.title || '')
    );
    // Pick a distinct line for this change. Title-affinity matches win; when
    // several match the SAME design they're interchangeable (pick the first).
    // Only bail when the match spans DIFFERENT designs (the #27253 ambiguity)
    // and there's no single fallback.
    let matched: (typeof candidates)[number] | null = null;
    if (byTitle.length >= 1 && new Set(byTitle.map((c) => c.pli.product_id)).size === 1) {
      matched = byTitle[0];
    } else if (candidates.length === 1) {
      matched = candidates[0];
    }
    if (!matched || matched.pli.quantity !== change.quantity) return null;

    // The new size/color must exist on the SAME Printify product.
    const newKey = labelTokens(change.newVariantTitle);
    const newPv =
      matched.prod.variants.find(
        (pv) => pv.is_enabled && labelTokens(pv.title) === newKey
      ) || matched.prod.variants.find((pv) => labelTokens(pv.title) === newKey);
    if (!newPv) return null;

    claimed.add(matched.idx);
    newVariantByIndex.set(matched.idx, newPv.id);
  }

  return {
    desiredLines: origCopy.line_items.map((pli, i) => ({
      product_id: pli.product_id,
      variant_id: newVariantByIndex.has(i) ? (newVariantByIndex.get(i) as number) : pli.variant_id,
      quantity: pli.quantity,
    })),
    changed: changes.map((c) => ({
      itemTitle: c.itemTitle,
      newVariantTitle: c.newVariantTitle,
    })),
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

      // Every changed line must be present on the replacement, on the RIGHT
      // design. Consume each matched line so two changes to the same
      // (design,variant) both need two lines - a count-aware check.
      const prodCache = new Map<string, PrintifyProduct | null>();
      const getProd = async (id: string) => {
        if (!prodCache.has(id)) {
          try {
            prodCache.set(id, await printify.getProduct(id));
          } catch {
            prodCache.set(id, null);
          }
        }
        return prodCache.get(id) ?? null;
      };
      const remaining = [...created.line_items];
      let allChangesFound = true;
      for (const ch of args.map.changed) {
        const want = labelTokens(ch.newVariantTitle);
        let hitIdx = -1;
        for (let i = 0; i < remaining.length; i++) {
          const li = remaining[i];
          const prod = await getProd(li.product_id);
          const v = prod?.variants.find((pv) => pv.id === li.variant_id);
          if (!v || labelTokens(v.title) !== want) continue;
          const liTitle = li.metadata?.title || prod?.title || '';
          if (titlesMatch(ch.itemTitle, liTitle)) {
            hitIdx = i;
            break;
          }
        }
        if (hitIdx < 0) {
          allChangesFound = false;
          break;
        }
        remaining.splice(hitIdx, 1);
      }
      verified = sameProducts && allChangesFound;
    }
  } catch {
    verified = false;
  }

  return { success: true, newPrintifyOrderId, verified };
}
