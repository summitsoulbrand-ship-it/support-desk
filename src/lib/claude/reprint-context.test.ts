import { describe, it, expect } from 'vitest';
import { ClaudeService } from './service';
import type { SuggestionContext } from './types';
import { reprintAsExistingReplacement } from '@/lib/ai/replacement-order';

// A replacement printed straight in Printify has no Shopify order, so before
// 2026-09-24 the draft never heard about it and could offer the customer a
// second replacement for the same shirt. These pin what the draft is shown.

const reprint = reprintAsExistingReplacement({
  printifyOrderId: '6a8b0c',
  appOrderId: '19269685.39876',
  forOrderName: '#37037',
  createdAt: '2026-09-18T05:20:12.000Z',
  stage: 'shipped',
  items: ['Surrender Premium - Graphite / L'],
  tracking: {
    carrier: 'DHL',
    number: '9261290223382099960691',
    url: 'https://easyordertracking.aftership.com/9261290223382099960691',
    shippedAt: '2026-09-19T18:00:00.000Z',
    deliveredAt: null,
  },
});

const context: SuggestionContext = {
  messages: [
    {
      from: 'Customer',
      date: '2026-09-24T12:00:00.000Z',
      subject: 'Re: my order',
      body: 'The shirt I got had a misprint, can you send me a new one?',
    },
  ],
  triage: { intent: 'ORDER_ISSUE', confidence: 0.9, entities: {} },
  replacementsAlreadyCreated: [reprint],
};

const text = new ClaudeService({ apiKey: 'test' }).renderContextForReview(context);

describe('draft prompt when Printify already reprinted the order', () => {
  it('lists the reprint among the replacements that already exist', () => {
    expect(text).toContain('Replacement orders that ALREADY EXIST');
    expect(text).toContain('replacing #37037');
    expect(text).toContain('SHIPPED on 2026-09-19');
  });

  it('gives the draft the replacement tracking to pass on', () => {
    expect(text).toContain('tracking: DHL 9261290223382099960691');
  });

  it('tells the draft not to promise another and how to name one with no number', () => {
    expect(text).toContain('do NOT promise to create one');
    expect(text).toContain('name the order it replaces');
  });

  it('marks the Printify number as ours alone', () => {
    const line = text.split('\n').find((l) => l.includes('replacing #37037')) || '';
    expect(line).toContain('never give it to the customer');
  });
});
