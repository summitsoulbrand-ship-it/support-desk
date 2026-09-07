/**
 * What a discount code actually requires, in words a customer can act on.
 *
 * The desk used to know a code's NAME and nothing else, so the most honest
 * reply it could write was "I am checking on that code and will follow up".
 * Measured on the Labor Day store-credit send: of twelve people who wrote in
 * about a code, three had simply put one shirt in a cart that needed two, and
 * every one of them got a promise to investigate instead of the one sentence
 * that would have answered them. Six more thought the credit was money sitting
 * in their account, because nothing told the model otherwise.
 *
 * So this reads the live terms off Shopify and states them plainly, and where
 * the customer's order is known it says which condition was missed. The
 * customer-facing wording is derived here rather than passed through: our
 * eligible-products collection is called "Store Credit Eligible (internal)"
 * and that name must never reach a customer.
 */

import type { RawDiscountNode, ShopifyOrder } from '@/lib/shopify/types';

export interface DiscountTerms {
  code: string;
  /** ACTIVE, EXPIRED or SCHEDULED as Shopify reports it. */
  status: string;
  /** "$11.95 off" / "15% off" / "free shipping", or null when unreadable. */
  value: string | null;
  endsAt: Date | null;
  startsAt: Date | null;
  minimumQuantity: number | null;
  minimumSubtotal: string | null;
  /** Excluded because the item is already discounted in a sale. */
  excludesSaleItems: boolean;
  /** Applies only to some of the catalog, beyond the sale exclusion. */
  limitedToSomeProducts: boolean;
  combinesWithOtherCodes: boolean;
  oncePerCustomer: boolean;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

const date = (v: unknown): Date | null => {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Read Shopify's discount payload into the handful of facts that decide
 * whether a code applies. Pure, so every branch is testable without the API.
 */
export function parseDiscountTerms(
  code: string,
  raw: RawDiscountNode | null
): DiscountTerms | null {
  const d = raw?.codeDiscount;
  if (!d) return null;

  const v = d.customerGets?.value;
  let value: string | null = null;
  if (d.__typename === 'DiscountCodeFreeShipping') {
    value = 'free shipping';
  } else if (v?.__typename === 'DiscountAmount') {
    const amount = num(v.amount?.amount);
    if (amount !== null) {
      value = `$${amount.toFixed(2)} off${v.appliesOnEachItem ? ' each item' : ''}`;
    }
  } else if (v?.__typename === 'DiscountPercentage') {
    const pct = num(v.percentage);
    // Shopify reports percentages as a fraction (0.15), not 15.
    if (pct !== null) value = `${Math.round(pct * 100)}% off`;
  }

  const min = d.minimumRequirement;
  const minimumQuantity =
    min?.__typename === 'DiscountMinimumQuantity'
      ? num(min.greaterThanOrEqualToQuantity)
      : null;
  const minSubtotal =
    min?.__typename === 'DiscountMinimumSubtotal'
      ? num(min.greaterThanOrEqualToSubtotal?.amount)
      : null;

  const items = d.customerGets?.items;
  const collections = items?.collections?.nodes ?? [];

  // A collection defined by "not tagged on-sale" is an exclusion of sale
  // items, not a hand-picked list - and that difference is the whole answer
  // for a customer holding a sale item.
  let excludesSaleItems = false;
  let ruleBasedOnly = collections.length > 0;
  for (const c of collections) {
    const rules = c.ruleSet?.rules ?? [];
    if (rules.length === 0) {
      ruleBasedOnly = false;
      continue;
    }
    for (const r of rules) {
      const isSaleRule =
        r.column === 'TAG' &&
        r.relation === 'NOT_EQUALS' &&
        /sale/i.test(String(r.condition || ''));
      if (isSaleRule) excludesSaleItems = true;
    }
  }

  // "Only some products" means a real restriction the customer can trip over.
  // A collection whose only rules are the sale/gift-card exclusions covers the
  // whole sellable catalog, so calling it a restriction would mislead.
  const namedProducts = (items?.products?.nodes ?? []).length > 0;
  const limitedToSomeProducts =
    namedProducts || (collections.length > 0 && !(ruleBasedOnly && excludesSaleItems));

  return {
    code: code.toUpperCase(),
    status: String(d.status || 'UNKNOWN'),
    value,
    startsAt: date(d.startsAt),
    endsAt: date(d.endsAt),
    minimumQuantity,
    minimumSubtotal: minSubtotal !== null ? `$${minSubtotal.toFixed(2)}` : null,
    excludesSaleItems,
    limitedToSomeProducts,
    combinesWithOtherCodes: !!(
      d.combinesWith?.orderDiscounts || d.combinesWith?.productDiscounts
    ),
    oncePerCustomer: !!d.appliesOncePerCustomer,
  };
}

/**
 * Discount windows are set in the STORE's timezone, so they must be described
 * in it. A code ending at 06:59 UTC is "midnight Pacific tonight" - the exact
 * words the marketing email used - but a container running on UTC would render
 * that as the NEXT day and tell the customer a deadline they never had.
 */
const STORE_TIMEZONE = process.env.STORE_TIMEZONE || 'America/Los_Angeles';

const fmtDate = (d: Date): string =>
  d.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: STORE_TIMEZONE,
  });

/** The code's conditions, one plain sentence each. */
export function describeConditions(terms: DiscountTerms): string[] {
  const out: string[] = [];

  if (terms.minimumQuantity && terms.minimumQuantity > 1) {
    out.push(`It needs at least ${terms.minimumQuantity} items in the cart.`);
  }
  if (terms.minimumSubtotal) {
    out.push(`It needs an order of at least ${terms.minimumSubtotal}.`);
  }
  if (terms.excludesSaleItems) {
    out.push('It does not apply to items that are already on sale.');
  }
  if (terms.limitedToSomeProducts) {
    out.push('It only applies to selected products.');
  }
  if (!terms.combinesWithOtherCodes) {
    out.push('It cannot be combined with another discount code.');
  }
  if (terms.oncePerCustomer) {
    out.push('It can be used once per customer.');
  }
  if (terms.endsAt) {
    const expired = terms.endsAt.getTime() < Date.now();
    out.push(
      expired
        ? `It expired on ${fmtDate(terms.endsAt)}.`
        : `It runs through ${fmtDate(terms.endsAt)}.`
    );
  }
  if (terms.status === 'SCHEDULED' && terms.startsAt) {
    out.push(`It does not start until ${fmtDate(terms.startsAt)}.`);
  }

  return out;
}

export interface DiscountDiagnosis {
  /** The condition the order missed, stated for the customer. Null if unclear. */
  reason: string | null;
  /** True when the code DID apply to this order - nothing to explain. */
  applied: boolean;
}

/**
 * Why the code did not come off THIS order. Returns a null reason rather than
 * a guess whenever the facts do not settle it: a wrong explanation is worse
 * than "let me check", because the customer acts on it.
 */
export function diagnoseOrder(
  terms: DiscountTerms,
  order: Pick<ShopifyOrder, 'lineItems' | 'createdAt' | 'discountCodes'> | null
): DiscountDiagnosis {
  if (!order) return { reason: null, applied: false };

  const codes = (order.discountCodes || []).map((c) => String(c).toUpperCase());
  if (codes.includes(terms.code)) return { reason: null, applied: true };

  const itemCount = (order.lineItems || []).reduce(
    (sum, li) => sum + (typeof li.quantity === 'number' ? li.quantity : 0),
    0
  );

  if (
    terms.minimumQuantity &&
    itemCount > 0 &&
    itemCount < terms.minimumQuantity
  ) {
    return {
      applied: false,
      reason:
        `This order has ${itemCount} item${itemCount === 1 ? '' : 's'} and the ` +
        `code needs at least ${terms.minimumQuantity}.`,
    };
  }

  const placed = date(order.createdAt);
  if (placed && terms.endsAt && placed.getTime() > terms.endsAt.getTime()) {
    return {
      applied: false,
      reason: `The code ended on ${fmtDate(terms.endsAt)} and this order was placed after that.`,
    };
  }
  if (placed && terms.startsAt && placed.getTime() < terms.startsAt.getTime()) {
    return {
      applied: false,
      reason: `The code did not start until ${fmtDate(terms.startsAt)} and this order was placed before that.`,
    };
  }

  if (codes.length > 0 && !terms.combinesWithOtherCodes) {
    return {
      applied: false,
      reason: `Another code was already on this order, and this one cannot be combined with it.`,
    };
  }

  return { reason: null, applied: false };
}
