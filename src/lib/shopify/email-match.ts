/**
 * Email-typo order matching.
 *
 * A very common failure: the customer mistypes their email DOMAIN at checkout
 * (zubrowskid@gmai.com) but emails support from the correct address
 * (zubrowskid@gmail.com). Exact-email lookup misses the order, and name matching
 * misses too when the sender's display name is noisy or absent.
 *
 * Shopify order search matches on the email local part (`email:zubrowskid`), so
 * we can find the order and then confirm it's the same person by requiring the
 * local part to be identical AND the domain to be a near-miss (small edit
 * distance) of the sender's domain. That combination is almost certainly a typo
 * by the same person - but it's still flagged unverified for a human to confirm,
 * since local part alone is not unique across domains.
 */

import type { ShopifyClient } from './client';
import type { ShopifyOrder } from './types';

const MIN_LOCAL_LEN = 4; // too-short local parts ("a", "abc") are risky
const MAX_DOMAIN_EDITS = 2; // gmail.com -> gmai.com is 1; allow up to 2

export function splitEmail(
  email: string | null | undefined
): { local: string; domain: string } | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return {
    local: email.slice(0, at).trim().toLowerCase(),
    domain: email.slice(at + 1).trim().toLowerCase(),
  };
}

/** Levenshtein edit distance (small strings, iterative two-row). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const curr = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      curr[j + 1] = Math.min(
        curr[j] + 1, // insertion
        prev[j + 1] + 1, // deletion
        prev[j] + cost // substitution
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Is `orderEmail` a likely typo of `senderEmail` by the same person? Same local
 * part, different-but-near-miss domain.
 */
export function isLikelyEmailTypo(
  senderEmail: string,
  orderEmail: string | null | undefined
): boolean {
  const s = splitEmail(senderEmail);
  const o = splitEmail(orderEmail);
  if (!s || !o) return false;
  if (s.local.length < MIN_LOCAL_LEN) return false;
  if (s.local !== o.local) return false; // local part must match exactly
  if (s.domain === o.domain) return false; // identical would've matched already
  return levenshtein(s.domain, o.domain) <= MAX_DOMAIN_EDITS;
}

export interface EmailTypoMatch {
  orders: ShopifyOrder[];
  /** The (mistyped) email actually on the matched order, for the caveat text. */
  orderEmail: string;
}

/**
 * Find orders whose email is a likely typo of the sender's. Searches Shopify by
 * the sender's local part, then filters to near-miss-domain matches. Returns
 * null when nothing qualifies.
 */
export async function findOrdersByEmailTypo(
  client: ShopifyClient,
  senderEmail: string
): Promise<EmailTypoMatch | null> {
  const s = splitEmail(senderEmail);
  if (!s || s.local.length < MIN_LOCAL_LEN) return null;

  // Shopify search token-matches the local part regardless of the typo'd domain.
  const candidates = await client.getOrdersByQuery(
    `email:${s.local.replace(/"/g, '')}`,
    25
  );
  const matches = candidates.filter((o) =>
    isLikelyEmailTypo(senderEmail, o.customerEmail)
  );
  if (matches.length === 0) return null;
  return { orders: matches, orderEmail: matches[0].customerEmail || '' };
}
