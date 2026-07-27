import { describe, it, expect } from 'vitest';
import { lintReply } from './reply-lint';

const rules = (text: string) => lintReply(text).map((w) => w.rule);

describe('lintReply', () => {
  it('passes a normal on-brand reply untouched', () => {
    expect(
      lintReply(
        "Hi Sarah, I just set up a free replacement in Medium - it's going into production today. " +
          'You can keep or donate the Small since having you ship it back would just create unnecessary waste and carbon emissions. Best, Pati'
      )
    ).toEqual([]);
  });

  it('flags the manufacturer name', () => {
    expect(rules('The Gildan tee is 100% cotton')).toContain('manufacturer-name');
  });

  it('flags em and en dashes', () => {
    expect(rules('Great news — it shipped')).toContain('em-dash');
    expect(rules('Great news – it shipped')).toContain('em-dash');
    expect(rules('Great news - it shipped')).not.toContain('em-dash');
  });

  it('flags Made in USA claims but not US-grown cotton', () => {
    expect(rules('Our shirts are made in the USA')).toContain('made-in-usa');
    expect(rules('printed on US-grown ring-spun cotton')).not.toContain('made-in-usa');
  });

  it('flags run-big sizing claims', () => {
    expect(rules('our tees can run big')).toContain('runs-big');
    expect(rules('these run a little large')).toContain('runs-big');
    expect(rules('our tees run a little small, so size up')).not.toContain('runs-big');
  });

  it('flags a dollar free-shipping threshold but not the item-count rule', () => {
    expect(rules('you get free shipping on orders over $75')).toContain('dollar-free-shipping');
    expect(rules('shipping is free on orders of 3 or more items')).not.toContain(
      'dollar-free-shipping'
    );
  });

  it('flags tracking-within-hours promises and the stale 10-14 day window', () => {
    expect(rules("you'll get tracking within 24 hours")).toContain('tracking-promise');
    expect(rules('it usually takes 10 to 14 days to arrive')).toContain('stale-timeline');
    expect(rules("you'll get tracking info as soon as it ships")).toEqual([]);
  });

  it('flags the vetoed cannot-change opener', () => {
    expect(rules("we can't change that original order, but")).toContain('cannot-change-opener');
  });

  it('flags billing-address confusion', () => {
    expect(rules('please confirm your billing address so we can ship it')).toContain(
      'billing-address'
    );
    expect(rules('only the shipping address matters for delivery')).not.toContain(
      'billing-address'
    );
  });

  it('flags unapproved short discount codes but allows approved and generated ones', () => {
    expect(rules('here is 20% off with code ROCKS25')).toContain('unknown-discount-code');
    expect(rules('here is 20% off with code THANKS20')).not.toContain('unknown-discount-code');
    // SORRY20 is a real make-good code Pati sends by hand (confirmed 2026-07-27).
    expect(rules('here is 20% off with code SORRY20')).not.toContain(
      'unknown-discount-code'
    );
    expect(rules('use code 516B08VDXA6P at checkout')).not.toContain('unknown-discount-code');
  });

  it('flags a real code with characters appended', () => {
    expect(rules('you can use THANKS20AGAIN for 20% off')).toContain(
      'invented-code-variant'
    );
    expect(rules('you can use THANKS20 for 20% off')).not.toContain(
      'invented-code-variant'
    );
  });

  it('flags draft-talk that would go straight to the customer', () => {
    const RULE = 'meta-draft-language';
    expect(
      rules("I can't add that discount code. If you'd like, I can revise the draft.")
    ).toContain(RULE);
    expect(rules("I'm not able to invent a code to include in a customer email")).toContain(
      RULE
    );
    expect(rules('Here is that version: Hi Kim, sorry for the trouble.')).toContain(RULE);
    expect(
      rules('Hi Kim, sorry for the trouble at checkout. Your replacement is on the way.')
    ).not.toContain(RULE);
  });

  it('flags the EU 14-day withdrawal wording for a double-check', () => {
    expect(rules('you have a 14-day right of withdrawal')).toContain(
      'fourteen-day-withdrawal-non-eu'
    );
  });

  it('lints HTML bodies by stripping tags first', () => {
    expect(rules('<p>The <b>Gildan</b> tee</p>')).toContain('manufacturer-name');
  });

  describe('store credit described as a card refund', () => {
    const RULE = 'store-credit-described-as-card-refund';
    const ctxRules = (text: string, ctx: Parameters<typeof lintReply>[1]) =>
      lintReply(text, ctx).map((w) => w.rule);

    // The real draft that nearly went out on #29290.
    const CARD_WORDING =
      'A refund of $34.95 has been issued back to your original payment method. Depending on your bank, it may take 3 to 5 business days to appear.';

    it('flags card wording when the refund was store credit', () => {
      expect(ctxRules(CARD_WORDING, { refundedToStoreCredit: true })).toContain(RULE);
    });

    it('also catches the casual "back on your card" phrasing', () => {
      expect(
        ctxRules('You should see it back on your card shortly.', {
          refundedToStoreCredit: true,
        })
      ).toContain(RULE);
    });

    it('stays quiet when the refund really did go to the card', () => {
      expect(ctxRules(CARD_WORDING, { refundedToStoreCredit: false })).not.toContain(RULE);
    });

    it('stays quiet when store credit is described correctly', () => {
      expect(
        ctxRules(
          'I have added $34.95 as store credit on your Summit Soul account - it will be waiting at checkout when you are signed in.',
          { refundedToStoreCredit: true }
        )
      ).not.toContain(RULE);
    });

    it('never fires without order context', () => {
      expect(rules(CARD_WORDING)).not.toContain(RULE);
    });
  });
});
