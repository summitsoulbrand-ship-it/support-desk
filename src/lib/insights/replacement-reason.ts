/**
 * Work out WHY a replacement is being sent, from what the customer wrote.
 *
 * Until now the reason was a chip an agent clicked in the sidebar, so most
 * replacements carried only 'Size Exchange' and landed in the dashboard's
 * "Unspecified" pile - 91 of 386 over two months. Reading the customer's own
 * words recovers about a third of those, and it is the only way the neck
 * complaint (the one that drives people to the v-neck) ever gets counted.
 *
 * Rules, not a model call: the phrasing is formulaic, every rule here was
 * checked against real threads, and a wrong tag quietly corrupts the metric
 * it feeds. Order matters - first match wins, most specific first.
 */

/**
 * The canonical reason vocabulary. One namespaced tag per reason, so a reason
 * can be told apart from workflow tags ('Replacement', 'combined-shipment') and
 * from Printify's `p_<hex>` ids, and so it survives someone typing a variant.
 *
 * Before this, the same reason arrived spelled four ways - 'too small' (185),
 * 'Too small' (89), 'too big' (117), 'Too large' (28) - and 'print' (21 orders,
 * the third most common reason in the store) matched no rule at all, so every
 * one of those print complaints was counted as Unspecified.
 */
export const REASON = {
  TOO_SMALL: 'reason:too-small',
  TOO_BIG: 'reason:too-big',
  NECK: 'reason:neck',
  PRINT: 'reason:print',
  DEFECT: 'reason:defect',
  WRONG_ITEM: 'reason:wrong-item',
  WRONG_SIZE_ORDERED: 'reason:wrong-size-ordered',
  COLOR: 'reason:color',
  NOT_DELIVERED: 'reason:not-delivered',
  ADDRESS: 'reason:address',
} as const;

export type ReplacementReasonTag = (typeof REASON)[keyof typeof REASON];

/** Every canonical tag, in the order a human would want them offered. */
export const REASON_TAGS: string[] = [
  REASON.TOO_SMALL,
  REASON.TOO_BIG,
  REASON.NECK,
  REASON.PRINT,
  REASON.DEFECT,
  REASON.WRONG_ITEM,
  REASON.WRONG_SIZE_ORDERED,
  REASON.COLOR,
  REASON.NOT_DELIVERED,
  REASON.ADDRESS,
];

/**
 * Every spelling seen on a real order, mapped to its canonical tag. Keys are
 * lowercased and trimmed before lookup. Legacy tags are never removed from an
 * order - the canonical one is added alongside - so nothing that reads the old
 * spelling breaks.
 */
const LEGACY_TO_CANONICAL: Record<string, ReplacementReasonTag> = {
  'too small': REASON.TOO_SMALL,
  'runs small': REASON.TOO_SMALL,
  'too big': REASON.TOO_BIG,
  'too large': REASON.TOO_BIG,
  neck: REASON.NECK,
  print: REASON.PRINT,
  'wrong print': REASON.PRINT,
  'print issue': REASON.PRINT,
  'print placement': REASON.PRINT,
  placement: REASON.PRINT,
  misprint: REASON.PRINT,
  defect: REASON.DEFECT,
  damaged: REASON.DEFECT,
  quality: REASON.DEFECT,
  'wrong shirt ordered': REASON.WRONG_ITEM,
  'wrong shirt': REASON.WRONG_ITEM,
  'wrong item': REASON.WRONG_ITEM,
  'wrong design': REASON.WRONG_ITEM,
  'wrong size sent': REASON.WRONG_ITEM,
  'wrong size ordered': REASON.WRONG_SIZE_ORDERED,
  'wrong size': REASON.WRONG_SIZE_ORDERED,
  'color change': REASON.COLOR,
  'wrong color': REASON.COLOR,
  'wrong color ordered': REASON.COLOR,
  color: REASON.COLOR,
  'not delivered': REASON.NOT_DELIVERED,
  lost: REASON.NOT_DELIVERED,
  'wrong address': REASON.ADDRESS,
};

/**
 * The canonical reason already on an order, from either a canonical tag or an
 * older spelling. Null when the tags say nothing about why.
 */
export function canonicalReasonFrom(tags: string[]): ReplacementReasonTag | null {
  const lower = tags.map((t) => t.trim().toLowerCase());
  for (const tag of lower) {
    if ((REASON_TAGS as string[]).includes(tag)) return tag as ReplacementReasonTag;
  }
  for (const tag of lower) {
    const mapped = LEGACY_TO_CANONICAL[tag];
    if (mapped) return mapped;
  }
  return null;
}

const RULES: { tag: ReplacementReasonTag; patterns: RegExp[] }[] = [
  {
    // A parcel that never arrived says nothing about the product. Tagging it
    // keeps lost mail from reading as a garment failure.
    tag: REASON.NOT_DELIVERED,
    patterns: [
      /(?:never|not|hasn'?t been|has not been|was not) (?:been )?(?:deliver|receiv|arriv)\w*/,
      /delivery failed|failed to deliver|delivery attempt/,
      /deliver\w+ to the wrong address/,
      /(?:lost|stolen|missing)[^.!?]{0,20}(?:package|parcel|shipment|order)/,
      /(?:package|parcel|shipment)[^.!?]{0,25}(?:lost|stolen|missing|never (?:came|arrived))/,
      /still (?:has ?n'?t|have ?n'?t|not) (?:arrived|received|come)/,
    ],
  },
  {
    tag: REASON.NECK,
    patterns: [
      /neck (?:hole|opening)[^.!?]{0,40}(?:small|tight|snug|narrow|tiny)/,
      /(?:small|tight|snug|narrow|tiny)[^.!?]{0,25}neck (?:hole|opening)/,
      /neck(?:line)?[^.!?]{0,30}(?:too )?(?:tight|snug|small|narrow|high)/,
      /(?:tight|snug|narrow)[^.!?]{0,20}(?:neck|collar)/,
      /collar[^.!?]{0,30}(?:tight|snug|small|high)/,
      /(?:can'?t|cannot|could ?n'?t|hard(?:ly)?)[^.!?]{0,30}(?:get|pull)[^.!?]{0,25}over my head/,
      /(?:cut|cutting) (?:out|off)[^.!?]{0,20}neck/,
      /chok(?:e|ing|es)[^.!?]{0,20}(?:me|neck)/,
    ],
  },
  {
    // Print quality and placement, kept apart from physical damage: one is the
    // art or the press, the other is the blank or the courier.
    tag: REASON.PRINT,
    patterns: [
      /(?:print|design|graphic|image|logo|lettering)[^.!?]{0,40}(?:crooked|off[- ]?cent|misprint|fad(?:ed|ing)|peel|crack|smear|blurry|blurred|wrong place|too (?:high|low|small|big)|not straight|uneven)/,
      /(?:crooked|off[- ]?cent(?:er|re)|misprint|fad(?:ed|ing)|peeling|cracking|smeared|blurry)[^.!?]{0,30}(?:print|design|graphic|image|lettering)/,
      /print(?:ing)? (?:quality|placement|is off|was off)/,
      /(?:washed out|came off|cracked)[^.!?]{0,25}(?:print|design|graphic)/,
    ],
  },
  {
    tag: REASON.DEFECT,
    patterns: [
      /\b(?:hole|tear|torn|rip(?:ped)?|stain(?:ed)?|defect(?:ive)?|damaged?)\b[^.!?]{0,45}(?:shirt|tee|sleeve|fabric|it|arrived)/,
      /(?:shirt|tee|it)[^.!?]{0,30}(?:has a hole|is torn|is ripped|is stained|arrived damaged|is defective)/,
      /(?:arrived|came)[^.!?]{0,15}damaged/,
      /poor quality|bad quality|quality (?:is|was) (?:poor|bad|terrible)/,
    ],
  },
  {
    tag: REASON.WRONG_ITEM,
    patterns: [
      /wrong (?:shirt|item|design|graphic|product|colou?r)/,
      /(?:not|isn'?t|is not)[^.!?]{0,20}what i ordered/,
      /received[^.!?]{0,25}instead of/,
    ],
  },
  {
    tag: REASON.TOO_BIG,
    patterns: [
      /(?:should have|shoulda|wish i(?:'d| had))[^.!?]{0,30}order\w*[^.!?]{0,30}(?:smaller|a medium|a small|down)/,
      /(?:too )?bagg(?:y|ie)|too (?:big|large|roomy|loose|long)/,
      /(?:go|size|drop) (?:down|a size down)|one size (?:down|smaller)/,
      /smaller size|a smaller one/,
    ],
  },
  {
    tag: REASON.TOO_SMALL,
    patterns: [
      /(?:should have|shoulda|wish i(?:'d| had))[^.!?]{0,30}order\w*[^.!?]{0,30}(?:bigger|larger|a large|an? xl|up)/,
      /(?:go|size) up|one size (?:up|bigger|larger)|go up to/,
      /too (?:small|tight|snug)|runs? small|fits? too tight/,
      /bigger size|a larger one|larger size/,
    ],
  },
];

/**
 * Strip the quoted reply chain. Without this our own words ("sorry the neck
 * opening was too tight") get read back as the customer's complaint and every
 * follow-up in a thread inherits the reason of the first.
 */
export function customerWordsOnly(body: string): string {
  return body
    .split(/\n\s*>|On .{5,80} wrote:|-{3,} ?Original Message/i)[0]
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DetectedReason {
  tag: ReplacementReasonTag;
  /** The phrase that triggered it, so a wrong tag can be traced, not guessed at. */
  phrase: string;
}

/** First matching rule wins, or null when the customer never said why. */
export function detectReplacementReason(text: string): DetectedReason | null {
  const haystack = (text || '').toLowerCase().replace(/\s+/g, ' ');
  if (!haystack) return null;

  for (const { tag, patterns } of RULES) {
    for (const pattern of patterns) {
      const match = haystack.match(pattern);
      if (match) {
        return { tag, phrase: match[0].slice(0, 100) };
      }
    }
  }
  return null;
}

/** True when the reason is already recorded, in which case we leave it alone. */
export function hasReasonTag(tags: string[]): boolean {
  return canonicalReasonFrom(tags) !== null;
}
