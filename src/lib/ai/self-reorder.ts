/**
 * "I already ordered the right size myself" - when is that true?
 *
 * Pati's rule (2026-09-22): offer to refund the wrong-size original ONLY when
 * the customer really placed a new order, and never mistake an unrelated second
 * order for one. Before this, the draft took the classifier's word for it: two
 * customers who only said they WOULD reorder ("I am reordering today", "I will
 * reorder") were told "you have already reordered" and offered a refund, and a
 * customer who really had reordered was offered a free extra shirt on top.
 *
 * So the refund path needs BOTH:
 * 1. the customer's own words say they reordered (or plan to), and
 * 2. Shopify shows the order: a real purchase placed after the first order
 *    shipped (before that they could not know the size was wrong).
 *
 * Pure functions (no DB, no Shopify) - context.ts feeds in the orders it
 * already fetched.
 */

import type { ShopifyLineItem, ShopifyOrder } from '@/lib/shopify/types';
import { designBaseTitle } from './design-versions';
import { replacementSignal } from './replacement-order';
import { sizesEquivalent } from './order-match';

export type ReorderMention = 'done' | 'planned';

// Past tense: they already bought the fix themselves.
const DONE: RegExp[] = [
  /\b(already|just)\s+(re-?ordered|ordered|bought|purchased|placed)\b/i,
  /\b(placed|made|put\s+in)\s+(another|a\s+new|a\s+second|a\s+separate)\s+order\b/i,
  /\bwent\s+ahead\s+and\s+(re-?ordered|ordered|bought|purchased)\b/i,
  /\bi\s+(have\s+)?re-?ordered\b/i,
  /\bi\s+(have\s+)?(ordered|bought|purchased)\s+(another|a\s+new|a\s+second|the\s+same)\b/i,
];

// Future: they are about to buy it themselves.
const PLANNED: RegExp[] = [
  /\b(i\s*will|i'll|ill|i\s*am\s*going\s*to|i'm\s*going\s*to|im\s*going\s*to|going\s*to|gonna|plan(ning)?\s*to|about\s*to)\s+(just\s+)?(re-?order|order|buy|purchase)\b/i,
  /\b(i\s*am|i'm|im)\s+(re-?ordering|ordering|buying|purchasing)\b/i,
  /\bre-?ordering\s+(today|tomorrow|now|soon|this\s+week)\b/i,
];

/**
 * What the customer says about buying the fix themselves. "done" wins when a
 * message has both ("I already ordered one and will order another").
 */
export function reorderMention(text: string): ReorderMention | null {
  const t = text.replace(/[‘’]/g, "'");
  if (DONE.some((r) => r.test(t))) return 'done';
  if (PLANNED.some((r) => r.test(t))) return 'planned';
  return null;
}

export interface SelfReorder {
  /** The customer's own new order. */
  newOrder: ShopifyOrder;
  /** The wrong-size order it replaces - the one to refund. */
  originalOrder: ShopifyOrder;
  /** True when the new order has the same design as the original, in another size. */
  sameDesign: boolean;
  /** "All Berries Are Edible Some Only Once Premium - Seafoam / XL" */
  newItem: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A fix is bought within weeks of the first order arriving, not months. */
const MAX_DAYS_AFTER_SHIPPING = 60;

function sizeOf(li: ShopifyLineItem): string | null {
  const opt = li.selectedOptions?.find((o) => /size/i.test(o.name))?.value;
  if (opt) return opt;
  const last = li.variantTitle?.split('/').pop()?.trim();
  return last || null;
}

/** A real purchase: not canceled, not free, not one of our replacements. */
function isRealPurchase(o: ShopifyOrder): boolean {
  const total = parseFloat(o.totalPrice || '0');
  return !o.cancelledAt && !isNaN(total) && total > 0 && !replacementSignal(o).isReplacement;
}

function firstShippedAt(o: ShopifyOrder): number | null {
  const times = (o.fulfillments || [])
    .map((f) => new Date(f.createdAt).getTime())
    .filter((t) => !isNaN(t));
  return times.length > 0 ? Math.min(...times) : null;
}

const label = (li: ShopifyLineItem) =>
  `${li.title}${li.variantTitle ? ` - ${li.variantTitle}` : ''}`;

/**
 * The customer's own replacement order, if Shopify shows one. Guards against
 * a random second order being taken for the fix:
 * - it must be a real purchase (paid, not canceled, not our free replacement);
 * - placed AFTER the original shipped - two sizes bought the same week are two
 *   shirts, not a fix - and within 60 days of it;
 * - best match: the same design in a DIFFERENT size (the same size again is a
 *   second shirt, not a fix); the size they asked for picks between several.
 *   A different design only counts when the customer said, in the past tense,
 *   that they already bought their replacement (the caller decides that).
 */
export function findSelfReorder(
  orders: ShopifyOrder[],
  opts: { requestedSize?: string; originalOrderId?: string } = {}
): SelfReorder | null {
  const byNewest = [...orders].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  // The order they complain about first when we know it, then newest first.
  const originals = [
    ...byNewest.filter((o) => o.id === opts.originalOrderId),
    ...byNewest.filter((o) => o.id !== opts.originalOrderId),
  ];

  let anyDesign: SelfReorder | null = null;
  for (const original of originals) {
    const shipped = firstShippedAt(original);
    if (shipped === null) continue; // not shipped: they cannot know the size is wrong
    const later = byNewest
      .filter((o) => o.id !== original.id && isRealPurchase(o))
      .filter((o) => {
        const at = new Date(o.createdAt).getTime();
        return at > shipped && at - shipped <= MAX_DAYS_AFTER_SHIPPING * DAY_MS;
      })
      .reverse(); // oldest first: the first fix they bought

    const sameDesign: SelfReorder[] = [];
    for (const candidate of later) {
      let duplicate = false;
      for (const was of original.lineItems) {
        const wasSize = sizeOf(was);
        if (!wasSize) continue;
        for (const now of candidate.lineItems) {
          const nowSize = sizeOf(now);
          if (!nowSize) continue;
          if (designBaseTitle(now.title).toLowerCase() !== designBaseTitle(was.title).toLowerCase()) continue;
          // The same design in the SAME size is a second shirt (a gift, a
          // double order), never the fix for a size that did not fit.
          if (sizesEquivalent(nowSize, wasSize)) {
            duplicate = true;
            continue;
          }
          sameDesign.push({ newOrder: candidate, originalOrder: original, sameDesign: true, newItem: label(now) });
        }
      }
      if (!duplicate && !anyDesign && candidate.lineItems.length > 0) {
        anyDesign = {
          newOrder: candidate,
          originalOrder: original,
          sameDesign: false,
          newItem: label(candidate.lineItems[0]),
        };
      }
    }
    if (sameDesign.length > 0) {
      // The size they named only picks between several - the classifier reads
      // sizes wrong often enough that it must not veto a clear match.
      const wanted = opts.requestedSize;
      return (
        (wanted && sameDesign.find((r) => sizesEquivalent(r.newItem.split('/').pop()!.trim(), wanted))) ||
        sameDesign[0]
      );
    }
  }
  return anyDesign;
}
