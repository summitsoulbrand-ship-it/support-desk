/**
 * Which designs on an order the customer's request is about - those first.
 *
 * The draft is shown the other garments, sizes and colors of only the first
 * two designs on the matched order: one design's list runs to about 3,000
 * characters, and most orders carry a single design. Taken in line order, that
 * cut fell on the very shirt a thread was about. Order #33685 held Cactus
 * Moon, Off to Cause Another Kerfuffle and Frog Wizard Kerfuffle; the whole
 * thread was about the Frog Wizard 3XL, which was never looked up, and the
 * draft offered it in colors copied from the other two designs (2026-09-23).
 *
 * Pure (no DB, no Shopify) so it can be tested on real orders.
 */

import { designBaseTitle } from './design-versions';
import { sizesEquivalent } from './order-match';
import { designPhrase } from './product-lookup';

export interface OrderLine {
  title: string;
  variantTitle?: string | null;
  selectedOptions?: { name: string; value: string }[] | null;
}

export interface RequestPointers {
  /** What the customer called the item (the classifier's line-item hints). */
  itemHints?: (string | null | undefined)[];
  /** The size they say they have now - the size to exchange FROM. */
  currentSizes?: (string | null | undefined)[];
  /** Titles of this order's items we already sent a replacement for. */
  replacedTitles?: string[];
}

/**
 * Words in a hint that never pick out a design: garments, sizes, and how
 * customers describe a shirt ("the 3X shirt with that saying").
 */
const NOT_A_NAME = new Set(
  (
    'shirt shirts tshirt tshirts tee tees top tops premium classic vintage ' +
    'hoodie hoodies sweatshirt sweatshirts crewneck sweater long short sleeve ' +
    'sleeves sleeved vneck neck heather kids kid toddler youth baby back front ' +
    'print design designs one ones size sizes color colors colour colours ' +
    'colored coloured same item items order ordered quote saying statement text ' +
    'graphic picture image wrong new other another both all two three ' +
    'small medium large extra xxl xxxl 2xl 3xl 4xl 5xl'
  ).split(' ')
);

function nameWords(text: string): string[] {
  return designPhrase(text).filter((w) => w.length >= 3 && !NOT_A_NAME.has(w));
}

function optionValue(line: OrderLine, name: RegExp): string | undefined {
  return line.selectedOptions?.find((o) => name.test(o.name))?.value;
}

/** "Mustard / 3XL" -> "3XL" when the line carries no Size option. */
function sizeOf(line: OrderLine): string | undefined {
  const parts = (line.variantTitle || '').split(' / ');
  return optionValue(line, /size/i) ?? (parts.length > 1 ? parts[parts.length - 1] : undefined);
}

/** "Mustard / 3XL" -> "Mustard" when the line carries no Color option. */
function colorOf(line: OrderLine): string | undefined {
  const parts = (line.variantTitle || '').split(' / ');
  return optionValue(line, /colou?r/i) ?? (parts.length > 1 ? parts[0] : undefined);
}

/**
 * The order's designs (each once, by designBaseTitle), the ones the request
 * points at first, in this order of strength: a design named in the item hint,
 * the line in the size they say they have, an item we already replaced from
 * this order, a color named in the hint. Ties keep the order's own line order,
 * so a request that points at nothing ranks exactly as before. A gift card is
 * not a design and is left out.
 */
export function rankOrderDesigns(lines: OrderLine[], pointers: RequestPointers = {}): string[] {
  const designLines = lines.filter((l) => !/gift ?card/i.test(l.title));
  const hintWords = new Set(
    (pointers.itemHints || []).flatMap((h) => (h ? nameWords(h) : []))
  );
  const sizes = (pointers.currentSizes || []).filter((s): s is string => !!s?.trim());
  const inSize = (line: OrderLine) => {
    const size = sizeOf(line);
    return !!size && sizes.some((s) => sizesEquivalent(size, s));
  };
  // A size every line shares ("all three are too small") points at none of them.
  const sizeSinglesOut = sizes.length > 0 && !designLines.every(inSize);
  const replaced = new Set(
    (pointers.replacedTitles || []).map((t) => designBaseTitle(t).toLowerCase())
  );

  const designs: { design: string; score: number; at: number }[] = [];
  const byKey = new Map<string, { named: boolean; sized: boolean; colored: boolean }>();
  for (const line of designLines) {
    const design = designBaseTitle(line.title);
    const key = design.toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, { named: false, sized: false, colored: false });
      designs.push({ design, score: 0, at: designs.length });
    }
    const flags = byKey.get(key)!;
    if (nameWords(design).some((w) => hintWords.has(w))) flags.named = true;
    if (nameWords(colorOf(line) || '').some((w) => hintWords.has(w))) flags.colored = true;
    if (sizeSinglesOut && inSize(line)) flags.sized = true;
  }
  for (const d of designs) {
    const key = d.design.toLowerCase();
    const flags = byKey.get(key)!;
    d.score =
      (flags.named ? 8 : 0) +
      (flags.sized ? 4 : 0) +
      (replaced.has(key) ? 2 : 0) +
      (flags.colored ? 1 : 0);
  }
  return designs.sort((a, b) => b.score - a.score || a.at - b.at).map((d) => d.design);
}
