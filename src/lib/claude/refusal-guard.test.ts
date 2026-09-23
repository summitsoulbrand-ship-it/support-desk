import { describe, it, expect } from 'vitest';
import { ClaudeService, replacementStatusWords } from './service';
import type { SuggestionContext } from './types';

// Vonda (#33685, 2026-09-23): the draft said it had "stopped" a replacement
// that shipped the day before, and offered her the same design in another
// color after she had refused three times. These pin the prompt wording that
// fixed it, so a later edit cannot drop it silently.

describe('replacementStatusWords', () => {
  it('spells out that a FULFILLED replacement can no longer be stopped', () => {
    expect(replacementStatusWords('FULFILLED')).toContain('can no longer be stopped');
    expect(replacementStatusWords('fulfilled')).toContain('already shipped');
  });

  it('leaves other statuses as they are', () => {
    expect(replacementStatusWords('UNFULFILLED')).toBe('UNFULFILLED');
    expect(replacementStatusWords(null)).toBe('unfulfilled');
  });
});

describe('draft prompt for a thread with a shipped replacement', () => {
  const context: SuggestionContext = {
    messages: [
      {
        from: 'Vonda',
        date: '2026-09-22T23:53:58.000Z',
        subject: 'Re: 33685',
        body: "I don't want another 3X shirt with the same statement...just a different color.",
      },
    ],
    triage: {
      intent: 'SIZE_EXCHANGE',
      confidence: 0.92,
      entities: { requestedSize: '3X', requestedColor: 'different color' },
    },
    replacementsAlreadyCreated: [
      {
        replacementOrder: '#39651',
        forOrder: '#33685',
        createdAt: '2026-09-21T22:56:16Z',
        fulfillmentStatus: 'FULFILLED',
        items: ['Frog Wizard Kerfuffle Premium - Mustard / 3XL'],
      },
    ],
  };
  const text = new ClaudeService({ apiKey: 'test' }).renderContextForReview(context);

  it('says the replacement has shipped and cannot be stopped', () => {
    expect(text).toContain('#39651');
    expect(text).toContain('can no longer be stopped');
  });

  it('tells the draft the classification is a guess that loses to the customer', () => {
    expect(text).toContain('quick automatic guess');
    expect(text).toContain('CUSTOMER DOES NOT WANT ANOTHER SHIRT');
  });
});
