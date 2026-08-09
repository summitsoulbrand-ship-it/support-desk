import { describe, it, expect } from 'vitest';
import { designBaseTitle, isChildSizing } from './design-versions';

describe('designBaseTitle', () => {
  it('reduces every garment to the same design', () => {
    const titles = [
      'Frog Wizard Kerfuffle',
      'Frog Wizard Kerfuffle Premium',
      'Frog Wizard Kerfuffle Kids Tee',
      'Frog Wizard Kerfuffle Toddler T-Shirt',
      'Frog Wizard Kerfuffle Premium LS',
      'Frog Wizard Kerfuffle V-Neck',
      'Frog Wizard Kerfuffle Premium (Back Print)',
    ];
    for (const t of titles) {
      expect(designBaseTitle(t)).toBe('Frog Wizard Kerfuffle');
    }
  });

  it('handles stacked garment words', () => {
    expect(designBaseTitle("It's Not Hoarding Rocks Funny Premium Hoodie")).toBe(
      "It's Not Hoarding Rocks Funny"
    );
    expect(designBaseTitle('Easily Distracted By Rocks Toddler Long Sleeve')).toBe(
      'Easily Distracted By Rocks'
    );
  });

  it('leaves a plain design name alone', () => {
    expect(designBaseTitle('Sorry Rocks')).toBe('Sorry Rocks');
    expect(designBaseTitle('American Bison')).toBe('American Bison');
  });

  it('never strips down to a fragment', () => {
    // Stripping these to nothing would search the whole catalog.
    expect(designBaseTitle('Premium')).toBe('Premium');
    expect(designBaseTitle('Kids Tee')).toBe('Kids Tee');
  });

  it('normalizes stray whitespace', () => {
    expect(designBaseTitle('  Wild Child   Kids Tee ')).toBe('Wild Child');
  });
});

describe('isChildSizing', () => {
  it('flags kids and toddler products', () => {
    expect(isChildSizing('Kids clothes', 'Frog Wizard Kerfuffle Toddler T-Shirt')).toBe(true);
    expect(isChildSizing('Kids clothes', 'Frog Wizard Kerfuffle Kids Tee')).toBe(true);
  });

  it('leaves adult products alone', () => {
    expect(isChildSizing('T-Shirt', 'Frog Wizard Kerfuffle')).toBe(false);
    expect(isChildSizing('V-neck', 'Frog Wizard Kerfuffle V-Neck')).toBe(false);
  });
});
