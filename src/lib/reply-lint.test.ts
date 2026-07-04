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
    expect(rules('here is 20% off with code SORRY20')).toContain('unknown-discount-code');
    expect(rules('here is 20% off with code THANKS20')).not.toContain('unknown-discount-code');
    expect(rules('use code 516B08VDXA6P at checkout')).not.toContain('unknown-discount-code');
  });

  it('flags the EU 14-day withdrawal wording for a double-check', () => {
    expect(rules('you have a 14-day right of withdrawal')).toContain(
      'fourteen-day-withdrawal-non-eu'
    );
  });

  it('lints HTML bodies by stripping tags first', () => {
    expect(rules('<p>The <b>Gildan</b> tee</p>')).toContain('manufacturer-name');
  });
});
