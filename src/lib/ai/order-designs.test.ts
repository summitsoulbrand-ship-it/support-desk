import { describe, it, expect } from 'vitest';
import { rankOrderDesigns, type OrderLine } from './order-designs';

/** An order line the way Shopify gives it: "Color / Size". */
function line(title: string, variant: string): OrderLine {
  const [color, size] = variant.split(' / ');
  return {
    title,
    variantTitle: variant,
    selectedOptions: [
      { name: 'Color', value: color },
      { name: 'Size', value: size },
    ],
  };
}

// #33685 (2026-09-23): the thread was about the Frog Wizard 3XL, the third
// design on the order, and only the first two were ever looked up.
const order33685 = [
  line('Cactus Moon', 'Heather Red / L'),
  line('Off to Cause Another Kerfuffle Premium', 'Terracotta / L'),
  line('Frog Wizard Kerfuffle Premium', 'Mustard / 3XL'),
];

describe('rankOrderDesigns', () => {
  it('puts the Frog Wizard first on #33685, from its classification and replacements', () => {
    expect(
      rankOrderDesigns(order33685, {
        itemHints: ['the 3X shirt with that saying', '3X shirt with the quote'],
        currentSizes: ['3X', '3X'],
        replacedTitles: ['Frog Wizard Kerfuffle Premium', 'Off to Cause Another Kerfuffle Premium'],
      })
    ).toEqual(['Frog Wizard Kerfuffle', 'Off to Cause Another Kerfuffle', 'Cactus Moon']);
  });

  it('finds the item from the size they have alone', () => {
    expect(rankOrderDesigns(order33685, { currentSizes: ['3X'] })[0]).toBe('Frog Wizard Kerfuffle');
  });

  it('finds the item from the replacements alone', () => {
    expect(
      rankOrderDesigns(order33685, { replacedTitles: ['Frog Wizard Kerfuffle Premium'] })[0]
    ).toBe('Frog Wizard Kerfuffle');
  });

  it('puts the design they named first', () => {
    // #35068 (2026-08-20): four V-necks, all 2XL.
    const order = [
      line('Licensed Ruckus Inspector II V-Neck Heather', 'Heather Slate / 2XL'),
      line('Rowing Toward a Ruckus V-Neck Heather', 'Athletic Heather / 2XL'),
      line('Wildflowers In A Glass V-Neck Heather', 'Heather Mauve / 2XL'),
      line('The Hullabaloo Committee V-Neck Heather', 'Heather Olive / 2XL'),
    ];
    expect(
      rankOrderDesigns(order, {
        itemHints: ['The Hullabaloo Committee V-Neck Heather'],
        currentSizes: ['2XL'],
      })
    ).toEqual([
      'The Hullabaloo Committee',
      'Licensed Ruckus Inspector II',
      'Rowing Toward a Ruckus',
      'Wildflowers In A Glass',
    ]);
  });

  it('ranks a named design above one that only shares the color they mentioned', () => {
    const order = [
      line('Ascending to Mischief Premium', 'Bay / XL'),
      line('Frog Wizard Kerfuffle Premium', 'Mustard / XL'),
      line('The Hullabaloo Committee Premium LS', 'Mustard / 2XL'),
    ];
    expect(
      rankOrderDesigns(order, { itemHints: ['the Hullabaloo Committee long sleeve in Mustard'] })[0]
    ).toBe('The Hullabaloo Committee');
  });

  it('reads nothing into a size every line shares', () => {
    const order = [
      line('Grand Canyon', 'Military Green / XL'),
      line('Natures Playground', 'Black / XL'),
      line('Wild America 250', 'Dark Heather / XL'),
    ];
    expect(rankOrderDesigns(order, { currentSizes: ['XL'] })).toEqual([
      'Grand Canyon',
      'Natures Playground',
      'Wild America 250',
    ]);
  });

  it('keeps line order when nothing points anywhere, one entry per design', () => {
    const order = [
      line('Surrender', 'Dark Heather / M'),
      line('Surrender Premium', 'Moss / L'),
      line('I Saw A Bird', 'Heather Indigo / M'),
    ];
    expect(rankOrderDesigns(order)).toEqual(['Surrender', 'I Saw A Bird']);
    expect(rankOrderDesigns(order, { itemHints: ['the shirt in the wrong size'] })).toEqual([
      'Surrender',
      'I Saw A Bird',
    ]);
  });

  it('leaves a gift card out', () => {
    const order = [
      { title: 'Summit Soul Gift Card', variantTitle: '$25.00' },
      line('Boop Funny', 'Light Blue / L'),
    ];
    expect(rankOrderDesigns(order)).toEqual(['Boop Funny']);
  });
});
