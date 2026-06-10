/**
 * Order matching for customer requests
 *
 * Picks which of a customer's orders a request (size exchange, cancellation,
 * address change) is about, using signals extracted from the email. Pure and
 * runtime-agnostic so the server (draft prompt) and client (action card) use
 * the exact same logic. When nothing clearly points to one order, it reports
 * the request as ambiguous so the UI can ask and the AI can ask the customer.
 */

export interface MatchableLineItem {
  title: string;
  variantTitle?: string | null;
  selectedOptions?: { name: string; value: string }[] | null;
}

export interface MatchableOrder {
  id: string;
  name: string; // "#14386"
  createdAt: string;
  lineItems: MatchableLineItem[];
}

export interface MatchSignals {
  /** Order number mentioned in the email, e.g. "14386" or "#14386" */
  orderNumber?: string | null;
  /** Product the customer referred to */
  lineItemHint?: string | null;
  /** Size the customer currently has (the one to exchange FROM) */
  currentSize?: string | null;
}

export type MatchConfidence = 'explicit' | 'inferred' | 'ambiguous' | 'single' | 'none';

export interface OrderMatchResult {
  matchedOrderId: string | null;
  confidence: MatchConfidence;
  /** Human-readable reason, e.g. "order #14386 named in the email" */
  reason: string;
  /** True when the agent/AI should confirm which order before acting */
  ambiguous: boolean;
}

function normalizeOrderNumber(s: string): string {
  return s.replace(/[^0-9]/g, '');
}

/** Expand common size words/abbreviations so "medium" matches "M" etc. */
function sizeTokens(size: string): string[] {
  const s = size.trim().toLowerCase();
  const map: Record<string, string[]> = {
    xs: ['xs', 'extra small', 'x-small'],
    s: ['s', 'small', 'sm'],
    m: ['m', 'medium', 'med'],
    l: ['l', 'large', 'lg'],
    xl: ['xl', 'extra large', 'x-large', '1xl'],
    '2xl': ['2xl', 'xxl', '2x', 'xx-large'],
    '3xl': ['3xl', 'xxxl', '3x'],
  };
  for (const [, tokens] of Object.entries(map)) {
    if (tokens.includes(s)) return tokens;
  }
  return [s];
}

const SIZE_ORDER = ['xs', 's', 'm', 'l', 'xl', '2xl', '3xl'];

/** Canonical size key (e.g. "Medium" -> "m"), or null if unrecognized */
export function canonicalSize(size: string): string | null {
  const s = size.trim().toLowerCase();
  for (const key of SIZE_ORDER) {
    if (key === s || sizeTokens(key).includes(s)) return key;
  }
  return null;
}

/** True when two size strings mean the same size ("L" === "Large") */
export function sizesEquivalent(a: string, b: string): boolean {
  const ca = canonicalSize(a);
  const cb = canonicalSize(b);
  if (ca && cb) return ca === cb;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** -1 if a is smaller than b, 1 if larger, 0 if equal/unknown */
export function compareSizes(a: string, b: string): number {
  const ia = SIZE_ORDER.indexOf(canonicalSize(a) || '');
  const ib = SIZE_ORDER.indexOf(canonicalSize(b) || '');
  if (ia < 0 || ib < 0) return 0;
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

function lineItemText(li: MatchableLineItem): string {
  const opts = (li.selectedOptions || []).map((o) => `${o.name} ${o.value}`).join(' ');
  return `${li.title} ${li.variantTitle || ''} ${opts}`.toLowerCase();
}

function orderHasSize(order: MatchableOrder, size: string): boolean {
  const tokens = sizeTokens(size);
  return order.lineItems.some((li) => {
    const text = lineItemText(li);
    // word-ish boundary check to avoid "s" matching every word
    return tokens.some((t) =>
      new RegExp(`(^|[^a-z])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(text)
    );
  });
}

function orderHasHint(order: MatchableOrder, hint: string): boolean {
  const h = hint.trim().toLowerCase();
  if (h.length < 3) return false;
  return order.lineItems.some((li) => lineItemText(li).includes(h));
}

/**
 * Determine which order a request is about.
 */
export function matchOrderForRequest(
  orders: MatchableOrder[],
  signals: MatchSignals
): OrderMatchResult {
  if (orders.length === 0) {
    return { matchedOrderId: null, confidence: 'none', reason: 'No orders found', ambiguous: false };
  }

  if (orders.length === 1) {
    return {
      matchedOrderId: orders[0].id,
      confidence: 'single',
      reason: 'Customer has a single order',
      ambiguous: false,
    };
  }

  // 1. Explicit order number wins
  if (signals.orderNumber) {
    const target = normalizeOrderNumber(signals.orderNumber);
    if (target) {
      const hit = orders.find((o) => normalizeOrderNumber(o.name) === target);
      if (hit) {
        return {
          matchedOrderId: hit.id,
          confidence: 'explicit',
          reason: `Order ${hit.name} named in the email`,
          ambiguous: false,
        };
      }
    }
  }

  // 2. Score by product hint + current size
  const scored = orders.map((o) => {
    let score = 0;
    if (signals.currentSize && orderHasSize(o, signals.currentSize)) score += 2;
    if (signals.lineItemHint && orderHasHint(o, signals.lineItemHint)) score += 1;
    return { order: o, score };
  });

  const maxScore = Math.max(...scored.map((s) => s.score));
  if (maxScore > 0) {
    const top = scored.filter((s) => s.score === maxScore);
    if (top.length === 1) {
      const parts: string[] = [];
      if (signals.currentSize) parts.push(`a ${signals.currentSize} item`);
      if (signals.lineItemHint) parts.push(`"${signals.lineItemHint}"`);
      return {
        matchedOrderId: top[0].order.id,
        confidence: 'inferred',
        reason: `Only ${top[0].order.name} matches ${parts.join(' / ') || 'the request'}`,
        ambiguous: false,
      };
    }
  }

  // 3. Multiple orders, no clear signal -> ambiguous
  return {
    matchedOrderId: null,
    confidence: 'ambiguous',
    reason: 'Multiple orders and no clear order number, product, or size in the email',
    ambiguous: true,
  };
}
