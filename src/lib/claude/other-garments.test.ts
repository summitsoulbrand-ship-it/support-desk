import { describe, it, expect } from 'vitest';
import { ClaudeService } from './service';
import type { DesignVersionFacts, SuggestionContext } from './types';

// #33685 (2026-09-23): the design the thread was about was never looked up,
// and a draft said it "comes in Mustard only". These pin the wording that
// keeps "not listed means we do not make it" to the designs actually shown.

function version(title: string, colors: string[], ordered = false): DesignVersionFacts {
  return {
    title,
    url: `https://summitsoul.shop/products/${title.toLowerCase().replace(/\s+/g, '-')}`,
    productType: 'T-Shirt',
    sizes: ['S', 'M', 'L', 'XL', '2XL', '3XL'],
    colors,
    childSizing: false,
    ordered,
  };
}

function render(extra: Partial<SuggestionContext>): string {
  const context: SuggestionContext = {
    messages: [
      {
        from: 'Customer',
        date: '2026-09-22T12:00:00.000Z',
        subject: 'Re: my order',
        body: 'Is the frog shirt made in any other colors?',
      },
    ],
    shopifyOrder: {
      orderNumber: '#33685',
      status: 'PAID',
      fulfillmentStatus: 'FULFILLED',
      createdAt: '2026-08-09T12:00:00Z',
      totalPrice: '99.85',
      currency: 'USD',
      lineItems: [
        { title: 'Cactus Moon - Heather Red / L', quantity: 1 },
        { title: 'Off to Cause Another Kerfuffle Premium - Terracotta / L', quantity: 1 },
        { title: 'Frog Wizard Kerfuffle Premium - Mustard / 3XL', quantity: 1 },
      ],
    },
    designVersions: [
      {
        design: 'Frog Wizard Kerfuffle',
        versions: [
          version('Frog Wizard Kerfuffle Premium', ['Mustard', 'Blue Jean'], true),
          version('Frog Wizard Kerfuffle', ['Natural', 'Heather Red']),
        ],
      },
    ],
    ...extra,
  };
  return new ClaudeService({ apiKey: 'test' }).renderContextForReview(context);
}

describe('The Same Design On Our Other Garments', () => {
  it('limits "we do not make it" to the designs it lists', () => {
    const text = render({});
    expect(text).toContain('ONLY other versions of the designs listed below');
    expect(text).toContain('of a listed design is not there, we do not make it');
    expect(text).toContain('- Frog Wizard Kerfuffle:');
  });

  it('names the designs on the order it leaves out', () => {
    const text = render({ designsNotListed: ['Cactus Moon', 'Wait, I see a rock'] });
    // Quoted, since design names carry commas of their own.
    expect(text).toContain(
      'Also on this order but not listed here: "Cactus Moon", "Wait, I see a rock".'
    );
    expect(text).toContain('say you will check - never that we do not make it');
  });

  it('adds nothing when every design is listed', () => {
    expect(render({})).not.toContain('not listed here');
  });
});
