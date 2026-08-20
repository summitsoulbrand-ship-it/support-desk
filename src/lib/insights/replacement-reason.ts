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

export type ReplacementReasonTag =
  | 'not delivered'
  | 'neck'
  | 'defect'
  | 'wrong shirt ordered'
  | 'too big'
  | 'too small';

/** Every tag this detector can apply, plus the ones agents apply by hand. */
export const REASON_TAGS: string[] = [
  'not delivered',
  'neck',
  'defect',
  'wrong shirt ordered',
  'wrong size ordered',
  'too big',
  'too small',
];

const RULES: { tag: ReplacementReasonTag; patterns: RegExp[] }[] = [
  {
    // A parcel that never arrived says nothing about the product. Tagging it
    // keeps lost mail from reading as a garment failure.
    tag: 'not delivered',
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
    tag: 'neck',
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
    tag: 'defect',
    patterns: [
      /(?:print|design|graphic|image|logo)[^.!?]{0,40}(?:crooked|off[- ]?cent|misprint|fad(?:ed|ing)|peel|crack|smear|blurry|blurred|wrong place|too (?:high|low|small|big))/,
      /(?:crooked|off[- ]?cent(?:er|re)|misprint|fad(?:ed|ing)|peeling|cracking|smeared)[^.!?]{0,30}(?:print|design|graphic|image)/,
      /\b(?:hole|tear|torn|rip(?:ped)?|stain(?:ed)?|defect(?:ive)?|damaged?)\b[^.!?]{0,45}(?:shirt|tee|sleeve|fabric|it|arrived)/,
      /(?:shirt|tee|it)[^.!?]{0,30}(?:has a hole|is torn|is ripped|is stained|arrived damaged|is defective)/,
      /(?:arrived|came)[^.!?]{0,15}damaged/,
      /poor quality|bad quality|quality (?:is|was) (?:poor|bad|terrible)/,
    ],
  },
  {
    tag: 'wrong shirt ordered',
    patterns: [
      /wrong (?:shirt|item|design|graphic|product|colou?r)/,
      /(?:not|isn'?t|is not)[^.!?]{0,20}what i ordered/,
      /received[^.!?]{0,25}instead of/,
    ],
  },
  {
    tag: 'too big',
    patterns: [
      /(?:should have|shoulda|wish i(?:'d| had))[^.!?]{0,30}order\w*[^.!?]{0,30}(?:smaller|a medium|a small|down)/,
      /(?:too )?bagg(?:y|ie)|too (?:big|large|roomy|loose|long)/,
      /(?:go|size|drop) (?:down|a size down)|one size (?:down|smaller)/,
      /smaller size|a smaller one/,
    ],
  },
  {
    tag: 'too small',
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

/** True when the agent already said why, in which case we leave it alone. */
export function hasReasonTag(tags: string[]): boolean {
  const lower = tags.map((t) => t.trim().toLowerCase());
  return REASON_TAGS.some((r) => lower.includes(r));
}
