/**
 * A design's base title - the part shared by every garment carrying the same
 * artwork. "Frog Wizard Kerfuffle Toddler T-Shirt" and "Frog Wizard Kerfuffle
 * Premium" both reduce to "Frog Wizard Kerfuffle", which is how we find the
 * other versions of what a customer ordered (Shopify has no design grouping).
 *
 * Why it matters: a customer who meant to buy the 5T and bought the adult S
 * needs the TODDLER product page for that same design. Without this the draft
 * could only reach for the kids COLLECTION, which dumps them into 16 unrelated
 * designs (order #32460, Pati 2026-08-09).
 */

/** Garment words we append to a design name, longest phrases first. */
const GARMENT_WORDS =
  '\\(back print\\)|back print|premium long sleeve|premium ls|long sleeve|longsleeve|sweatshirt|hoodie|crewneck|v-?neck heather|v-?neck|kids tee|kids t-shirt|kids sweatshirt|kids long sleeve|toddler long sleeve|toddler t-shirt|toddler tee|toddler|kids|youth|premium|t-shirt|tee|shirt';

/** The garment words trailing a title: " ... Toddler T-Shirt". */
const GARMENT_SUFFIX = new RegExp(`\\s+(?:${GARMENT_WORDS})$`, 'i');

/** A title that is NOTHING but a garment word - never a design name. */
const ONLY_GARMENT = new RegExp(`^(?:${GARMENT_WORDS})$`, 'i');

/**
 * Strip the garment words off a product title. Repeats so stacked suffixes
 * ("... Premium (Back Print)", "... Premium Hoodie") come all the way off.
 * Returns the title unchanged when stripping would leave nothing meaningful.
 */
export function designBaseTitle(productTitle: string): string {
  let title = productTitle.trim().replace(/\s+/g, ' ');
  for (let i = 0; i < 4; i++) {
    const stripped = title.replace(GARMENT_SUFFIX, '').trim();
    // Never strip down to a fragment: a remainder that is ITSELF nothing but
    // garment words ("Kids Tee" -> "Kids" -> "") is not a design name, and
    // searching it would match the whole catalog.
    if (stripped === title || stripped.length < 3 || ONLY_GARMENT.test(stripped)) break;
    title = stripped;
  }
  return title;
}

/** Does this product's size list read as child sizing (2T-5T, XS-XL youth)? */
export function isChildSizing(productType: string, title: string): boolean {
  const t = `${productType} ${title}`.toLowerCase();
  return /kid|toddler|youth|baby|infant|onesie/.test(t);
}
