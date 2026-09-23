import { describe, it, expect } from 'vitest';
import { goldenTemplatesForIntent, GOLDEN_TEMPLATES } from './golden-templates';

/**
 * A template that announces a finished refund is the right reply once the
 * operator has actually refunded - and a trap before that, because the prompt
 * tells the model to mirror these closely. Order #30877 got "our system
 * automatically processed a full refund" sent to a customer with no refund at
 * all (Pati, 2026-08-09).
 */
const announcesRefund = (reply: string) =>
  /(already|I have|I've|we have|we've)\s+(processed|issued|refunded|canceled|cancelled)|processed (your|a full) refund/i.test(
    reply
  );

describe('golden templates and completed money actions', () => {
  it('withholds refund-announcing templates when nothing was refunded', () => {
    for (const intent of new Set(GOLDEN_TEMPLATES.map((g) => g.intent))) {
      const shown = goldenTemplatesForIntent(intent, undefined, 10, false);
      expect(
        shown.filter((t) => announcesRefund(t.reply)),
        `intent ${intent} leaked a refund-announcing template`
      ).toHaveLength(0);
    }
  });

  it('shows them once the refund is confirmed', () => {
    // At least one intent in the library has such a template, or this guard is
    // testing nothing.
    const withRefundClaims = GOLDEN_TEMPLATES.filter((g) => announcesRefund(g.reply));
    expect(withRefundClaims.length).toBeGreaterThan(0);

    const intent = withRefundClaims[0].intent;
    const shown = goldenTemplatesForIntent(intent, undefined, 10, true);
    expect(shown.some((t) => announcesRefund(t.reply))).toBe(true);
  });

  it('keeps the other ORDER_ISSUE examples when the risky one is withheld', () => {
    expect(goldenTemplatesForIntent('ORDER_ISSUE', undefined, 10, false).length).toBe(
      goldenTemplatesForIntent('ORDER_ISSUE', undefined, 10, true).length - 1
    );
  });

  it('also withholds "I\'m processing a full refund ... I\'ve also canceled" (RETURN_REFUND)', () => {
    // The first filter only knew "processed"/"I've canceled", so this example
    // reached every refund thread before any refund existed.
    expect(goldenTemplatesForIntent('RETURN_REFUND', undefined, 10, false)).toHaveLength(0);
    expect(goldenTemplatesForIntent('RETURN_REFUND', undefined, 10, true).length).toBeGreaterThan(0);
  });

  it('shows the THANKS20 design-idea example only when triage flagged a design idea', () => {
    const hasCode = (xs: { reply: string }[]) => xs.some((t) => /THANKS20/.test(t.reply));
    // A catalog question used to get it as the closest match by keywords.
    expect(
      hasCode(goldenTemplatesForIntent('PRODUCT_QUESTION', 'Do you make the frog wizard design in a hoodie?', 3))
    ).toBe(false);
    expect(
      hasCode(
        goldenTemplatesForIntent('PRODUCT_QUESTION', 'You should make a design about morel mushrooms', 3, false, true)
      )
    ).toBe(true);
  });

  it('leaves CANCELLATION with no examples until the cancel is confirmed', () => {
    // Its only template opens "Done - I've canceled order #X and processed your
    // refund", which is precisely the sentence we must not teach before the
    // operator has clicked Cancel. The draft writes from the rules instead,
    // and gets the template back the moment the action is recorded.
    expect(goldenTemplatesForIntent('CANCELLATION', undefined, 10, false)).toHaveLength(0);
    expect(
      goldenTemplatesForIntent('CANCELLATION', undefined, 10, true).length
    ).toBeGreaterThan(0);
  });
});
