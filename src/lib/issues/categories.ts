/**
 * The issue taxonomy the daily report is built on.
 *
 * Two distinctions carry the whole report and are worth stating plainly:
 *
 *  - A PROBLEM vs not. Praise and pre-sale questions are real mail but they
 *    are not something to fix, so they are counted and then kept out of the
 *    "biggest issues" list and out of every spike test.
 *  - A PRODUCT-QUALITY problem vs everything else. Only these get attributed
 *    to a design, because only these are fixed by changing artwork or dropping
 *    a product. A late package is not the design's fault.
 */

import { IssueCategory, IssueSeverity } from '@prisma/client';

/** Plain-English label for the email. No jargon - Pati reads this, not code. */
export const CATEGORY_LABEL: Record<IssueCategory, string> = {
  PRINT_QUALITY: 'Print / design problem',
  GARMENT_QUALITY: 'Shirt quality problem',
  SIZING_FIT: 'Size or fit',
  WRONG_ITEM: 'Wrong item shipped',
  SHIPPING_DELAY: 'Slow shipping',
  NOT_DELIVERED: 'Never arrived',
  ADDRESS_CHANGE: 'Address change',
  CANCELLATION: 'Cancellation',
  REFUND_RETURN: 'Refund or return',
  DISCOUNT_CODE: 'Discount code trouble',
  WEBSITE_CHECKOUT: 'Website or checkout',
  PRODUCT_QUESTION: 'Question before buying',
  PRAISE: 'Praise',
  OTHER: 'Other',
};

/**
 * Categories that mean something went wrong. Everything else is mail we are
 * glad to get. ADDRESS_CHANGE and CANCELLATION sit here because they are work
 * that has to happen, and a jump in either says something upstream changed.
 */
export const PROBLEM_CATEGORIES: IssueCategory[] = [
  'PRINT_QUALITY',
  'GARMENT_QUALITY',
  'SIZING_FIT',
  'WRONG_ITEM',
  'SHIPPING_DELAY',
  'NOT_DELIVERED',
  'ADDRESS_CHANGE',
  'CANCELLATION',
  'REFUND_RETURN',
  'DISCOUNT_CODE',
  'WEBSITE_CHECKOUT',
];

export function isProblem(category: IssueCategory): boolean {
  return PROBLEM_CATEGORIES.includes(category);
}

/**
 * Something is WRONG with what we shipped: the print failed, the garment
 * failed, or the wrong thing arrived. These are rare, they repeat on the same
 * design when the design or its print file is the cause, and two strangers
 * reporting one is worth interrupting Pati for.
 *
 * SIZING IS DELIBERATELY NOT HERE (Pati, 2026-09-10). It was, and it drowned
 * everything: 22 of the first 24 design-attributed issues were plain size
 * exchanges, and two of the three alarms that fired were two people wanting a
 * different size. On a made-to-order unisex tee that is ordinary trade, not a
 * fault. Frog Wizard's genuinely broken artwork - a frog printed with five
 * legs - was sitting in the same alert as four size swaps.
 */
export const PRODUCT_DEFECT_CATEGORIES: IssueCategory[] = [
  'PRINT_QUALITY',
  'GARMENT_QUALITY',
  'WRONG_ITEM',
];

export function isDefect(category: IssueCategory): boolean {
  return PRODUCT_DEFECT_CATEGORIES.includes(category);
}

/**
 * Categories worth attributing to a design at all - defects plus sizing.
 * Sizing still gets a design name because the TREND per design is the thing
 * Pati wants ("only the overall trend per product"); it just never counts as
 * a fault on its own.
 */
export const PRODUCT_QUALITY_CATEGORIES: IssueCategory[] = [
  ...PRODUCT_DEFECT_CATEGORIES,
  'SIZING_FIT',
];

export function isProductQuality(category: IssueCategory): boolean {
  return PRODUCT_QUALITY_CATEGORIES.includes(category);
}

/** Order the report lists categories in - worst first, not alphabetical. */
export const CATEGORY_ORDER: IssueCategory[] = [
  'PRINT_QUALITY',
  'GARMENT_QUALITY',
  'WRONG_ITEM',
  'NOT_DELIVERED',
  'SHIPPING_DELAY',
  'SIZING_FIT',
  'REFUND_RETURN',
  'CANCELLATION',
  'ADDRESS_CHANGE',
  'DISCOUNT_CODE',
  'WEBSITE_CHECKOUT',
  'PRODUCT_QUESTION',
  'PRAISE',
  'OTHER',
];

export const SEVERITY_RANK: Record<IssueSeverity, number> = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};
