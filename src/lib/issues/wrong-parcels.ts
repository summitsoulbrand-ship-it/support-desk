/**
 * What was wrong with a wrong parcel.
 *
 * A wrong color, a wrong design, a wrong size, a missing shirt and an extra
 * item are all WRONG_ITEM, and they used to be read per design: "Surrender - 2
 * customers: received wrong color; received wrong shirt". But a wrong parcel
 * is a packing error at Printify, not the artwork, and the same packing
 * problem shows up on many designs at once - so the daily report groups them
 * by what went wrong, across every design (Pati, 2026-09-22). Two of that
 * day's cases were checked against their Shopify orders: the orders were
 * right and the parcels were wrong.
 *
 * New rows carry the kind from the classifier. Older rows do not, and the
 * 14-day window keeps them in the report for two weeks after the column
 * appeared, so there is a phrase reader for those - on the model's own short
 * summaries, which are formulaic enough for it. It is a fallback, never the
 * first choice.
 */

export const WRONG_ITEM_KINDS = [
  'wrong_color',
  'wrong_design',
  'wrong_size',
  'missing_item',
  'extra_item',
  'other',
] as const;

export type WrongItemKind = (typeof WRONG_ITEM_KINDS)[number];

/** Plain words for the email. */
export const WRONG_ITEM_KIND_LABEL: Record<WrongItemKind, string> = {
  wrong_color: 'wrong color',
  wrong_design: 'wrong design',
  wrong_size: 'wrong size',
  missing_item: 'shirt missing',
  extra_item: 'extra item',
  other: 'wrong item',
};

export function isWrongItemKind(v: unknown): v is WrongItemKind {
  return typeof v === 'string' && (WRONG_ITEM_KINDS as readonly string[]).includes(v);
}

// Garment color names a summary might use instead of the word "color":
// "ordered Crimson but received gray". Comfort Colors and Gildan names.
const COLOR_NAMES =
  'gray|grey|black|white|blue|navy|red|crimson|green|moss|olive|military green|' +
  'graphite|charcoal|heather|brown|tan|sand|mustard|yellow|orange|pink|berry|' +
  'purple|violet|teal|bay|ivory|cream|natural|espresso|maroon|burgundy|khaki|' +
  'pepper|blue jean|granite|sage|lavender|watermelon|chalky mint|butter|' +
  'banana|seafoam|crunchberry|topaz|denim|royal caribe|island reef|' +
  'terracotta|forest|hemp|light blue|dark chocolate|ice blue|lagoon|' +
  'true navy|sport grey|dark heather|safety green|cardinal|gold|orchid';

const QUALIFIER = '(?:wrong|different|incorrect|instead|not the (?:right|correct)|off)';
/** Up to N words between two anchors, so "wrong shirt color" and "wrong color" both hit. */
const NEAR = (n: number) => `(?:\\W+\\w+){0,${n}}?\\W+`;

const MISSING = new RegExp(
  '\\bmissing\\b|\\bonly (?:received|got|had) (?:one|two|three|\\d)\\b|' +
    '\\bshort(?:ed)? (?:one|a|an|two|by)\\b|' +
    '\\b(?:not|never) (?:receive|get|includ)\\w* (?:one|both|all|the other|the second|the rest)\\b',
  'i'
);
const EXTRA = new RegExp(
  '\\bextra\\b|\\badditional\\b|\\b(?:did not|didn\'?t|never) order\\w*\\b|' +
    '\\badded to (?:my|the|their|her|his) order\\b',
  'i'
);
const COLOR = new RegExp(
  `\\b${QUALIFIER}\\b${NEAR(3)}(?:colou?r|shade)\\b|` +
    `\\b(?:colou?r|shade)\\b${NEAR(3)}${QUALIFIER}\\b|` +
    `\\b(?:received|got|sent|arrived|came|shipped)\\b${NEAR(3)}(?:${COLOR_NAMES})\\b(?:\\W+\\w+){0,6}?\\W+instead\\b|` +
    `\\b(?:received|got|sent|arrived|came|shipped)\\b${NEAR(2)}(?:${COLOR_NAMES})\\b${NEAR(2)}(?:not|instead|rather)\\b`,
  'i'
);
const SIZE = new RegExp(
  `\\b${QUALIFIER}\\b${NEAR(2)}size\\b|\\bsize\\b${NEAR(2)}${QUALIFIER}\\b|` +
    `\\b(?:received|got|sent|arrived|came)\\b${NEAR(3)}(?:xs|small|medium|large|xl|2xl|3xl|4xl|5xl|x-large|xx-large|xxl|xxxl)\\b(?:\\W+\\w+){0,6}?\\W+instead\\b`,
  'i'
);
const DESIGN = new RegExp(
  `\\b(?:wrong|different|incorrect|not what)\\b${NEAR(3)}(?:designs?|shirts?|items?|products?|prints?|graphics?|tees?|t-shirts?|styles?|order)\\b|` +
    `\\binstead\\b|\\bnot what (?:i|we|she|he|they) ordered\\b`,
  'i'
);

/**
 * Read the kind out of the words - the row's problem, detail and summary.
 * Missing and extra are checked first because "missing one shirt" also
 * mentions a shirt; color before design because "wrong shirt color" mentions
 * both; design last because "instead" alone means something else arrived.
 */
export function wrongItemKindFromText(
  ...parts: (string | null | undefined)[]
): WrongItemKind {
  const text = parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' ')
    .toLowerCase();
  if (!text) return 'other';
  if (MISSING.test(text)) return 'missing_item';
  if (EXTRA.test(text)) return 'extra_item';
  if (COLOR.test(text)) return 'wrong_color';
  if (SIZE.test(text)) return 'wrong_size';
  if (DESIGN.test(text)) return 'wrong_design';
  return 'other';
}
