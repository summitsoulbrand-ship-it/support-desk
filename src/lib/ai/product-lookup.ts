/**
 * Find the designs a customer NAMES in their message, in the full store
 * catalog - so the draft can link the real product, name its real colors and
 * sizes, and never tell a customer we do not make something we sell.
 *
 * Why: the draft used to read a product list cut to its first ~87 of 1,064
 * active products. In September 2026 it told three customers that live designs
 * did not exist ("Here Come the Shenanigans", "On a Dark Desert Highway", a
 * Fluffy Cow long sleeve). The operator caught all three by hand.
 *
 * Pure functions only (no DB, no Shopify) - the caller in context.ts loads the
 * catalog index and fetches live details for what matches.
 */

import { designBaseTitle } from './design-versions';

export interface CatalogEntry {
  title: string;
  handle: string;
  productType: string;
}

/** Words that never identify a design on their own. */
const FILLER = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
  'by', 'from', 'as', 'is', 'it', 'its', 'be', 'i', 'im', 'me', 'my', 'we',
  'our', 'you', 'your', 'no', 'not', 'so', 'do', 'does', 'this', 'that',
  // A listing suffix on older titles ("Overthinking Funny"), never the design.
  'funny',
]);

/** Garment words that appear in handles ("t-shirts-...-t-shirt"). */
const HANDLE_NOISE = new Set([
  't', 'shirt', 'shirts', 'tshirt', 'tee', 'tees', 'hoodie', 'hoodies',
  'sweatshirt', 'sweatshirts', 'md', 'premium', 'ls',
]);

/** Lowercase words with apostrophes dropped ("Don't" -> "dont"). */
export function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['‘’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

/** The words that identify a design, in order, fillers removed. */
export function designPhrase(text: string): string[] {
  return wordsOf(text).filter((w) => !FILLER.has(w));
}

/** Does `needle` appear as a contiguous run inside `hay`? */
function containsRun(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Words that mark the words before them as a product name ("the Boop tee"). */
const PRODUCT_WORDS = new Set([
  'shirt', 'shirts', 'tshirt', 'tshirts', 'tee', 'tees', 'hoodie', 'hoodies',
  'sweatshirt', 'sweatshirts', 'crewneck', 'sweater', 'design', 'designs',
  'long', 'premium', 'vneck', 'v', 'top',
]);

/**
 * Everyday words. A design name made ONLY of these ("Good Luck", "Take Me
 * With You", "Not Today") reads as an ordinary sentence far more often than
 * as a product, so it needs product-like wording to count.
 */
const COMMON_WORDS = new Set(
  (
    'about after again all also always am any anything are around away back bad ' +
    'because been before being best better big but buy call came can cant come ' +
    'could day days did didnt dont down each even ever every everything family ' +
    'feel few find first friend friends get gets getting give go going gone good ' +
    'got great had has have having he her here hers him his home hope how if into ' +
    'just keep kind know last least let life like little live long look lot love ' +
    'luck made make many may maybe mean mentally more most much must need never ' +
    'new next nice night nothing now off office old once one only other out over ' +
    'own people please put really right said same say see she should since some ' +
    'something soon still such sure take than thank thanks their them then there ' +
    'these they thing things think those though time today together too two under ' +
    'until up us use very want was way week well went were what when where which ' +
    'while who why will wish work would yes yet control name bought buy ordered order ' +
    'orders received receive sent send wear wearing wore fit fits size color gift gifts ' +
    'return loved liked shirt shirts'
  ).split(' ')
);

/**
 * Nature words customers use to DESCRIBE a shirt ("the rock one", "my bird
 * shirt"). A one-word design with such a name ("I Rock") only counts in quotes.
 */
const GENERIC_NOUNS = new Set(
  (
    'rock rocks bird birds tree trees mountain mountains nature bear bears frog ' +
    'frogs cow cows moose bison buffalo fish owl owls shell shells stick sticks ' +
    'crystal crystals mushroom mushrooms coffee cat cats dog dogs hike hiking ' +
    'camp camping forest lake river flower flowers sun moon star stars'
  ).split(' ')
);

/** Word runs inside double quotes, as design phrases. */
function quotedPhrases(rawMessage: string): string[][] {
  const out: string[][] = [];
  for (const m of rawMessage.matchAll(/["\u201C\u201D]([^"\u201C\u201D]{2,80})["\u201C\u201D]/g)) {
    out.push(designPhrase(m[1]));
  }
  return out;
}

/** Start index of `needle` as a contiguous run inside `hay`, or -1. */
function runAt(hay: string[], needle: string[]): number {
  if (needle.length === 0 || needle.length > hay.length) return -1;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Is a design name used as a NAME in this message? Checked against the whole
 * catalog and 1,285 real customer emails (2026-09-22): our designs are named
 * with everyday phrases ("The Good", "Not Today", "I Rock", "Out of Office,
 * Mentally"), and a loose match fired on 401 of those emails, mostly on
 * ordinary sentences and out-of-office auto-replies. So the whole name must
 * appear in order, and a name that is one word or only everyday words must
 * also be written like a product: in double quotes, or followed by a garment
 * word ("the Surrender shirt", "Good Luck tee").
 */
function namedInMessage(
  phrase: string[],
  msgPhrase: string[],
  rawMessage: string
): boolean {
  if (phrase.length === 0 || phrase.join('').length < 4) return false;
  const at = runAt(msgPhrase, phrase);
  if (at === -1) return false;
  const specific =
    phrase.length >= 2
      ? phrase.some((w) => !COMMON_WORDS.has(w))
      : !COMMON_WORDS.has(phrase[0]) && !GENERIC_NOUNS.has(phrase[0]);
  const quoted = quotedPhrases(rawMessage).some((q) => runAt(q, phrase) !== -1);
  if (phrase.length >= 2 && specific) return true;
  if (quoted) return true;
  // A one-word name that is an everyday word or a nature word only ever
  // counts in quotes: "I bought the shirt" is not the "I Bought It for the"
  // design, and "the rock shirt" is not "I Rock".
  if (phrase.length === 1 && !specific) return false;
  return PRODUCT_WORDS.has(msgPhrase[at + phrase.length] || '');
}

/**
 * Parse the catalog index row ("- Title [Type]: https://.../products/handle").
 * Lines that do not match are skipped.
 */
export function parseCatalogIndex(content: string): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^- (.+?)(?: \[([^\]]*)\])?: \S*\/products\/([^\s/?#]+)\s*$/);
    if (m) out.push({ title: m[1].trim(), productType: (m[2] || '').trim(), handle: m[3] });
  }
  return out;
}

/**
 * The designs whose name the customer used, longest (most specific) first,
 * each with every catalog entry that carries that name in its title or link.
 * A design matches only when all of its identifying words appear IN ORDER in
 * the message ("fluffy cow" inside "don't pet the fluffy cow"), so "Alien
 * Desert Highway" does not match a customer asking for "Dark Desert Highway".
 */
export function findMentionedDesigns(
  message: string,
  catalog: CatalogEntry[],
  maxDesigns = 3,
  maxEntriesPerDesign = 14
): { design: string; entries: CatalogEntry[] }[] {
  const msg = designPhrase(message);
  if (msg.length === 0 || catalog.length === 0) return [];
  // The gift card is not a design ("Summit Soul Gift Card").
  const products = catalog.filter(
    (e) => !/gift ?card/i.test(e.title) && !/gift ?card/i.test(e.productType)
  );

  // One candidate per distinct phrase; the shortest title gives the cleanest
  // design name ("Fluffy Cow" over "The Fluffy Cow Funny").
  const candidates = new Map<string, { phrase: string[]; name: string }>();
  for (const entry of products) {
    const base = designBaseTitle(entry.title);
    const phrase = designPhrase(base);
    if (!namedInMessage(phrase, msg, message)) continue;
    const key = phrase.join(' ');
    const name = base.replace(/\s+funny$/i, '').trim();
    const seen = candidates.get(key);
    if (!seen || name.length < seen.name.length) candidates.set(key, { phrase, name });
  }

  // Most specific first; drop a shorter phrase that sits inside a longer
  // match ("desert highway" when "dark desert highway" matched).
  const ranked = [...candidates.values()].sort(
    (a, b) => b.phrase.length - a.phrase.length || b.phrase.join('').length - a.phrase.join('').length
  );
  const chosen: { phrase: string[]; name: string }[] = [];
  for (const c of ranked) {
    if (chosen.some((k) => containsRun(k.phrase, c.phrase))) continue;
    chosen.push(c);
    if (chosen.length >= maxDesigns) break;
  }

  return chosen.map(({ phrase, name }) => ({
    design: name,
    entries: products
      .filter((e) => {
        const titleWords = designPhrase(e.title);
        const handleWords = designPhrase(e.handle).filter((w) => !HANDLE_NOISE.has(w));
        return containsRun(titleWords, phrase) || containsRun(handleWords, phrase);
      })
      .slice(0, maxEntriesPerDesign),
  }));
}
