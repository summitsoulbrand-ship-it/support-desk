import { describe, it, expect } from 'vitest';
import {
  findMentionedDesigns,
  parseCatalogIndex,
  wordsOf,
  type CatalogEntry,
} from './product-lookup';

// Real titles and handles from the live store (2026-09-22).
const CATALOG: CatalogEntry[] = [
  { title: 'Alien Desert Highway', handle: 't-shirts-alien-desert-highway-t-shirt', productType: 'T-Shirt' },
  { title: 'Alien Desert Highway Premium', handle: 't-shirts-alien-desert-highway-t-shirt-premium', productType: 'T-Shirt' },
  { title: 'Dark Desert (no Alien)', handle: 't-shirts-dark-desert-highway-t-shirt', productType: 'T-Shirt' },
  { title: 'Dark Desert Highway Premium', handle: 'dark-desert-highway-premium', productType: 'T-Shirt' },
  { title: 'Dark Desert Highway V-Neck Heather', handle: 'dark-desert-highway-v-neck-heather', productType: 'T-Shirt' },
  { title: 'Here Come the Shenanigans', handle: 'here-come-the-shenanigans', productType: 'T-Shirt' },
  { title: 'Here Come the Shenanigans Premium', handle: 'here-come-the-shenanigans-premium', productType: 'T-Shirt' },
  { title: 'Here Come the Shenanigans V-Neck Heather', handle: 'here-come-the-shenanigans-v-neck-heather', productType: 'T-Shirt' },
  { title: 'Here Come the Shenanigans Premium LS', handle: 'here-come-the-shenanigans-premium-ls', productType: 'Long Sleeve' },
  { title: 'Buffalo Shenanigans', handle: 't-shirts-buffalo-shenanigans', productType: 'T-Shirt' },
  { title: 'The Fluffy Cow Funny', handle: 't-shirts-the-fluffy-cow-funny-t-shirt', productType: 'T-Shirt' },
  { title: 'Fluffy Cow Premium', handle: 'fluffy-cow-premium', productType: 'T-Shirt' },
  { title: 'Fluffy Cow Premium LS', handle: 'fluffy-cow-premium-ls', productType: 'Long Sleeve' },
  { title: 'Frog Wizard Kerfuffle Premium', handle: 't-shirts-frog-wizard-kerfuffle-premium', productType: 'T-Shirt' },
  { title: 'Frog Wizard Kerfuffle Premium LS', handle: 'frog-wizard-kerfuffle-premium-ls', productType: 'Long Sleeve' },
  { title: 'I Saw A Bird Premium', handle: 't-shirts-i-saw-a-bird-premium', productType: 'T-Shirt' },
  { title: 'Wait, I See A Bird Premium', handle: 'wait-i-see-a-bird-premium', productType: 'T-Shirt' },
  { title: 'Wait, I see a rock Premium', handle: 'wait-i-see-a-rock-premium', productType: 'T-Shirt' },
  { title: 'Be You', handle: 't-shirts-be-you-t-shirt', productType: 'T-Shirt' },
  { title: 'Surrender Premium', handle: 'surrender-premium', productType: 'T-Shirt' },
  { title: 'The Good', handle: 't-shirts-the-good-t-shirt', productType: 'T-Shirt' },
  { title: 'Not Today', handle: 'not-today', productType: 'T-Shirt' },
  { title: 'Out of Office, Mentally', handle: 'out-of-office-mentally', productType: 'T-Shirt' },
  { title: 'I Rock', handle: 'i-rock', productType: 'T-Shirt' },
  { title: 'Summit Soul Gift Card', handle: 'gift-card', productType: 'Gift Card' },
  { title: 'Good Luck', handle: 'good-luck', productType: 'T-Shirt' },
  { title: 'I Bought It for the Premium', handle: 'i-bought-it-for-the-premium', productType: 'T-Shirt' },
  { title: 'Boop Funny V-Neck', handle: 'boop-funny-v-neck', productType: 'V-neck' },
];

const titles = (r: { entries: CatalogEntry[] }) => r.entries.map((e) => e.title);

describe('findMentionedDesigns', () => {
  it('finds a design the old cut-off list denied existed (Christine, 2026-09-16)', () => {
    const r = findMentionedDesigns(
      'We would like the "Here Come the Shenanigans" V-Neck Tee in XL please',
      CATALOG
    );
    expect(r).toHaveLength(1);
    expect(r[0].design).toBe('Here Come the Shenanigans');
    expect(titles(r[0])).toEqual([
      'Here Come the Shenanigans',
      'Here Come the Shenanigans Premium',
      'Here Come the Shenanigans V-Neck Heather',
      'Here Come the Shenanigans Premium LS',
    ]);
    // "Buffalo Shenanigans" shares a word, not the name.
    expect(titles(r[0])).not.toContain('Buffalo Shenanigans');
  });

  it('matches a name inside a longer phrase and groups every garment (Mark, 2026-09-22)', () => {
    const r = findMentionedDesigns(
      'Do you make the "Don\'t pet the fluffy cow" in a long sleeve',
      CATALOG
    );
    expect(r[0].design).toBe('Fluffy Cow');
    expect(titles(r[0])).toEqual([
      'The Fluffy Cow Funny',
      'Fluffy Cow Premium',
      'Fluffy Cow Premium LS',
    ]);
  });

  it('keeps Dark Desert Highway apart from Alien Desert Highway, and finds the classic by its link (Cecelia, 2026-09-11)', () => {
    const r = findMentionedDesigns(
      "Here is what Id like to order: On a Dark Desert Highway; Color: Navy; Size Xl.",
      CATALOG
    );
    expect(r).toHaveLength(1);
    expect(r[0].design).toBe('Dark Desert Highway');
    const t = titles(r[0]);
    expect(t).toContain('Dark Desert (no Alien)');
    expect(t).toContain('Dark Desert Highway Premium');
    expect(t.some((x) => x.startsWith('Alien'))).toBe(false);
  });

  it('returns nothing for a design we do not make (Barb, 2026-09-14)', () => {
    expect(
      findMentionedDesigns('Anything with RED (Retired Extremely Dangerous) on it?', CATALOG)
    ).toEqual([]);
  });

  it('returns nothing for an ordinary question', () => {
    expect(findMentionedDesigns('Where is my order? It has been a week.', CATALOG)).toEqual([]);
  });

  it('needs the whole name - a partial name finds nothing rather than guessing', () => {
    // A looser pass matched 401 of 1,285 real emails, mostly junk (2026-09-22).
    expect(
      findMentionedDesigns('I love the frog kerfuffle shirt, is it in a long sleeve?', CATALOG)
    ).toEqual([]);
    expect(
      findMentionedDesigns('Is the Frog Wizard Kerfuffle in a long sleeve?', CATALOG)[0]?.design
    ).toBe('Frog Wizard Kerfuffle');
  });

  it('counts a one-word name only when it is written like a product', () => {
    expect(findMentionedDesigns('Could I get the Surrender shirt in XL?', CATALOG)[0]?.design).toBe(
      'Surrender'
    );
    expect(findMentionedDesigns('I love "Surrender" - is it on a hoodie?', CATALOG)[0]?.design).toBe(
      'Surrender'
    );
    expect(findMentionedDesigns('I surrender, the website beat me', CATALOG)).toEqual([]);
    expect(findMentionedDesigns('The rock one was for me and it fits', CATALOG)).toEqual([]);
  });

  it('ignores everyday phrases that happen to be design names', () => {
    expect(
      findMentionedDesigns(
        'I will be out of the office Monday through Wednesday with limited access to email.',
        CATALOG
      )
    ).toEqual([]);
    expect(findMentionedDesigns('The good news is it finally arrived!', CATALOG)).toEqual([]);
    expect(findMentionedDesigns('Not today, maybe next week', CATALOG)).toEqual([]);
  });

  it('needs product wording for a name made of everyday words or a bare nature word', () => {
    expect(findMentionedDesigns('Good luck with your business, love the shirts', CATALOG)).toEqual([]);
    expect(findMentionedDesigns('Is the Good Luck tee back in stock?', CATALOG)[0]?.design).toBe('Good Luck');
    expect(findMentionedDesigns('The rock shirt was for my husband', CATALOG)).toEqual([]);
    expect(findMentionedDesigns('I bought the shirt for a friend', CATALOG)).toEqual([]);
    expect(findMentionedDesigns('Do you still make "I Rock"?', CATALOG)[0]?.design).toBe('I Rock');
    expect(
      findMentionedDesigns('A medium in the Boop funny v-neck would work better', CATALOG)[0]?.design
    ).toBe('Boop');
  });

  it('never offers the gift card as a design', () => {
    expect(findMentionedDesigns('Can I buy a Summit Soul gift card?', CATALOG)).toEqual([]);
  });

  it('does not treat one shared word as a match', () => {
    expect(findMentionedDesigns('I saw a hawk and a rock', CATALOG)).toEqual([]);
  });

  it('never searches a name made only of filler words', () => {
    expect(findMentionedDesigns('Be you, be kind', CATALOG)).toEqual([]);
  });

  it('prefers the more specific of two overlapping names', () => {
    const r = findMentionedDesigns('Is Wait, I See A Bird on a hoodie?', CATALOG);
    expect(r.map((d) => d.design)).toEqual(['Wait, I See A Bird']);
  });
});

describe('parseCatalogIndex', () => {
  it('reads the refresh line format and skips the header', () => {
    const content =
      'Every active product and its link (lookup index, never sent as a list).\n' +
      '- Fluffy Cow Premium LS [Long Sleeve]: https://summitsoul.shop/products/fluffy-cow-premium-ls\n' +
      '- Be You: https://summitsoul.shop/products/t-shirts-be-you-t-shirt\n' +
      'not a product line';
    expect(parseCatalogIndex(content)).toEqual([
      { title: 'Fluffy Cow Premium LS', productType: 'Long Sleeve', handle: 'fluffy-cow-premium-ls' },
      { title: 'Be You', productType: '', handle: 't-shirts-be-you-t-shirt' },
    ]);
  });
});

describe('wordsOf', () => {
  it('drops apostrophes so contractions match', () => {
    expect(wordsOf("Don't Pet the Walkin’ Cow")).toEqual(['dont', 'pet', 'the', 'walkin', 'cow']);
  });
});
