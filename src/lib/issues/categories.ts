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
  WEBSITE_CHECKOUT: 'Website, checkout or payment',
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
 * Categories allowed to interrupt Pati with an alarm. Every problem except
 * sizing.
 *
 * A size exchange is a problem in the sense that it is work - it is counted
 * in the daily report like everything else - but it is never news, at any
 * volume (Pati, 2026-09-16: "its not a pattern if some customers want a size
 * exchange"). Left in, a busy week of perfectly ordinary swaps clears the
 * spike bar and fires "Size or fit: 6 customers in 48 hours", which is the
 * fastest way to teach someone to ignore alarms.
 */
export function raisesAlarm(category: IssueCategory): boolean {
  return isProblem(category) && category !== 'SIZING_FIT';
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
 *
 * Sizing keeps its design name even though NOTHING reports on it per design
 * any more (Pati, 2026-09-16: "its not a pattern if some customers want a size
 * exchange"). The name is a column, not a section: recording it costs nothing
 * and means the question "which designs run small" can still be answered if
 * she ever asks it, whereas dropping it would throw the answer away daily.
 */
export const PRODUCT_QUALITY_CATEGORIES: IssueCategory[] = [
  ...PRODUCT_DEFECT_CATEGORIES,
  'SIZING_FIT',
];

export function isProductQuality(category: IssueCategory): boolean {
  return PRODUCT_QUALITY_CATEGORIES.includes(category);
}

/**
 * Everything that can stand between a customer and a completed order: the
 * store itself, and the codes and credits they try to pay with.
 *
 * The two are kept together because they fail together and Pati reads them as
 * one question - "can people buy right now?". Measured on 2026-09-11, three
 * customers hit the same "cannot change payment method at checkout" bug within
 * a day; split across two categories neither half looked like anything, and
 * the daily report showed the whole thing as one number.
 *
 * Membership here is not enough to be listed: the row also has to say a
 * purchase was actually BLOCKED. Of 32 discount-code messages in 30 days, most
 * were people asking whether a sale was on.
 */
export const CHECKOUT_CATEGORIES: IssueCategory[] = [
  'WEBSITE_CHECKOUT',
  'DISCOUNT_CODE',
];

export function isCheckout(category: IssueCategory): boolean {
  return CHECKOUT_CATEGORIES.includes(category);
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
