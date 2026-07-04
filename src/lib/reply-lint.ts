/**
 * Outbound brand-lint: checks a reply (AI-drafted or human-typed) against the
 * hard brand rules right before it goes out, and returns human-readable
 * warnings for the composer to show. It never blocks a send - the operator
 * can always proceed - but a new VA gets the rule surfaced at the exact
 * moment it matters instead of after the customer already read the mistake.
 *
 * Keep this list to HIGH-RISK factual/brand violations only (things that are
 * wrong no matter the situation). Tone and style stay coaching territory -
 * they belong in the playbook, not in a send-time nag.
 */

/** Codes we legitimately hand out. Freshly generated one-off codes (random
 *  10+ char strings from the discount tool) are also fine - the pattern
 *  check below only fires on short, marketing-looking codes. */
const APPROVED_CODES = new Set(['THANKS20', 'WELCOME15', 'WHOLESALE30']);

export interface ReplyLintWarning {
  /** Stable id so the UI can de-duplicate/suppress if ever needed. */
  rule: string;
  /** What tripped, quoted from the reply where useful. */
  message: string;
}

interface LintRule {
  rule: string;
  test: (text: string) => string | null;
}

const RULES: LintRule[] = [
  {
    rule: 'manufacturer-name',
    test: (t) =>
      /\bgildan\b/i.test(t)
        ? 'Says "Gildan" - never use the manufacturer name with a customer; call it the "classic tee".'
        : null,
  },
  {
    rule: 'em-dash',
    test: (t) =>
      /[—–]/.test(t)
        ? 'Contains an em/en dash - brand rule is plain hyphens (-) only.'
        : null,
  },
  {
    rule: 'made-in-usa',
    test: (t) =>
      /made in (the )?(usa|u\.s\.a\.|us|u\.s\.|united states|america)/i.test(t)
        ? 'Claims "Made in USA" - the cotton is US-grown but sewing happens in Central America. Say "US-grown cotton" instead.'
        : null,
  },
  {
    rule: 'runs-big',
    test: (t) =>
      /\bruns? (a (little|bit) )?(big|large)\b/i.test(t)
        ? 'Says the shirts "run big" - our tees run SMALL (that is what the exchange data shows). Never claim they run big.'
        : null,
  },
  {
    rule: 'dollar-free-shipping',
    test: (t) =>
      /free shipping (on|for|over|above|at) (orders? (of |over |above )?)?\$\s?\d/i.test(t)
        ? 'Promises free shipping at a dollar amount - free shipping is by ITEM COUNT (3 or more items), there is no dollar threshold.'
        : null,
  },
  {
    rule: 'tracking-promise',
    test: (t) =>
      /tracking (number |info(rmation)? )?(with)?in \d+ ?(hours|hrs)/i.test(t)
        ? 'Promises tracking within a set number of hours - we never promise that. Production is up to 4 business days, then 2-5 business days shipping.'
        : null,
  },
  {
    rule: 'stale-timeline',
    test: (t) =>
      /\b10 (to|-) ?14 (business )?days\b/i.test(t)
        ? 'Quotes the old "10 to 14 days" window - the standard answer is up to 4 business days production plus 2-5 business days shipping. (Exception: the wholesale terms legitimately say 10-14 days.)'
        : null,
  },
  {
    rule: 'cannot-change-opener',
    test: (t) =>
      /(cannot|can't|can not) change (that|the|your) original/i.test(t)
        ? 'Uses the "we cannot change the original" line - vetoed. Confirm what we ARE doing (the free replacement) without the stamp about the original.'
        : null,
  },
  {
    rule: 'billing-address',
    test: (t) =>
      /(update|confirm|fix|correct)[^.!?]{0,40}\bbilling address\b|\bbilling address\b[^.!?]{0,40}(update|confirm|fix|correct)/i.test(t)
        ? 'Asks the customer about their BILLING address - only the shipping address ever matters for delivery. Never ask them to fix or confirm billing.'
        : null,
  },
  {
    rule: 'unknown-discount-code',
    test: (t) => {
      // "code XYZ123" phrasing with a short marketing-looking code that is
      // not on the approved list (long random strings are the generated
      // one-off codes and are fine).
      const m = t.match(/\bcode[:\s]+([A-Z0-9]{4,10})\b/);
      if (m && !APPROVED_CODES.has(m[1].toUpperCase())) {
        return `Offers discount code "${m[1]}" - not an approved code (THANKS20 / WELCOME15 / WHOLESALE30, or a freshly generated one-off code).`;
      }
      return null;
    },
  },
  {
    rule: 'fourteen-day-withdrawal-non-eu',
    test: (t) =>
      /14[- ]day (right of )?withdrawal/i.test(t)
        ? 'Mentions the 14-day withdrawal right - that is EU-only (ship-to in the EU-27). Double-check this order ships to the EU before offering it.'
        : null,
  },
];

/** Lint an outgoing reply body (plain text or HTML - tags are stripped). */
export function lintReply(body: string): ReplyLintWarning[] {
  const text = body.replace(/<[^>]*>/g, ' ');
  const warnings: ReplyLintWarning[] = [];
  for (const r of RULES) {
    const message = r.test(text);
    if (message) warnings.push({ rule: r.rule, message });
  }
  return warnings;
}
