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
const APPROVED_CODES = new Set([
  'THANKS20',
  'WELCOME15',
  'WHOLESALE30',
  // Real make-good code (Pati confirmed 2026-07-27). The AI had been refusing
  // it as invented while she was sending it by hand, which cost a full rewrite
  // in the 2026-07-19 edit digest.
  'SORRY20',
]);

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
    // Our sizing is unisex, cut to a men's spec: it runs SMALL on men and
    // BIGGER on women. So "runs big" is only wrong as a blanket claim - it is
    // correct, and the advice we want, when the sentence is about women. Only
    // flag the sentence that actually makes the claim, and only when it has no
    // women/her framing in it.
    rule: 'runs-big',
    test: (t) => {
      const claim = /\bruns? (a (little|bit) )?(big|large|bigger|larger|roomy|roomier)\b/i;
      const female = /\b(wom[ae]n'?s?|female|she|her|hers|ladies|lady)\b/i;
      const offending = t
        .split(/(?<=[.!?\n])\s+/)
        .find((sentence) => claim.test(sentence) && !female.test(sentence));
      return offending
        ? 'Says the shirts "run big" with no women/men split - our unisex tees run SMALL on men and bigger on women. Never claim they run big as a blanket statement.'
        : null;
    },
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
    // The model once addressed the OPERATOR inside a customer draft ("I can't
    // add that discount code... If you'd like, I can revise the draft"), which
    // shows the customer straight into our tooling. Prompt rules alone cannot
    // guarantee this never slips out, so it gets caught at send time too.
    rule: 'meta-draft-language',
    test: (t) => {
      const m = t.match(
        /\b(revise|rewrite|regenerate) the draft\b|\bthe draft\b|\bhere is that version\b|\bhere's that version\b|\bI'?m not able to invent\b|\bI can'?t (add|include|invent) that\b|\bas an AI\b|\blet me know if you want me to (change|adjust|revise)\b/i
      );
      return m
        ? `Talks about the draft itself ("${m[0]}") - this text goes straight to the customer. Rewrite it as a normal reply to them.`
        : null;
    },
  },
  {
    // A real code with something appended ("THANKS20AGAIN") looks plausible but
    // does not exist at checkout, so the customer hits an error. Distinct from
    // the unknown-code rule above, which only fires on short "code XYZ" forms.
    rule: 'invented-code-variant',
    test: (t) => {
      for (const code of APPROVED_CODES) {
        const m = t.match(new RegExp(`\\b(${code}[A-Z0-9]+)\\b`));
        if (m) {
          return `Uses "${m[1]}" - that is ${code} with extra characters added, which is not a real code. Use ${code} exactly, or a generated one-off code.`;
        }
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

/** Facts about the order being replied about, for rules that only make sense
 *  in context. Optional everywhere - callers without it just get the
 *  text-only rules. */
export interface ReplyLintContext {
  /** A refund on this order went out as store credit, not to the card. */
  refundedToStoreCredit?: boolean;
}

/** Rules that need order context, not just the words in the reply. */
const CONTEXT_RULES: {
  rule: string;
  test: (text: string, ctx: ReplyLintContext) => string | null;
}[] = [
  {
    // A store-credit refund described as a card refund sends the customer
    // watching a bank statement for money that is never arriving. Caught in
    // the wild on #29290 before it was sent.
    rule: 'store-credit-described-as-card-refund',
    test: (t, ctx) => {
      if (!ctx.refundedToStoreCredit) return null;
      const claimsCard =
        /original payment method|back (on|to) your (card|bank)|onto your card|to your card|your bank|business days to appear|refunded to your/i.test(
          t
        );
      return claimsCard
        ? 'This order was refunded as STORE CREDIT, but the reply says the money is going back to their card or bank. No money is moving - say the amount is on their Summit Soul account to use at checkout.'
        : null;
    },
  },
];

/** Lint an outgoing reply body (plain text or HTML - tags are stripped). */
export function lintReply(
  body: string,
  context?: ReplyLintContext
): ReplyLintWarning[] {
  const text = body.replace(/<[^>]*>/g, ' ');
  const warnings: ReplyLintWarning[] = [];
  for (const r of RULES) {
    const message = r.test(text);
    if (message) warnings.push({ rule: r.rule, message });
  }
  if (context) {
    for (const r of CONTEXT_RULES) {
      const message = r.test(text, context);
      if (message) warnings.push({ rule: r.rule, message });
    }
  }
  return warnings;
}
