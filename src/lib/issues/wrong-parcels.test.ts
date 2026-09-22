import { describe, it, expect } from 'vitest';
import { isWrongItemKind, wrongItemKindFromText } from './wrong-parcels';

/**
 * Every phrase here is one the classifier actually wrote on a real row in the
 * Sep 21 and Sep 22 reports, so the fallback is tested on the wording it will
 * meet, not on wording that suits it.
 */
describe('wrongItemKindFromText', () => {
  it('reads a wrong color', () => {
    expect(wrongItemKindFromText('received wrong color')).toBe('wrong_color');
    expect(wrongItemKindFromText('wrong brand and color received')).toBe('wrong_color');
    expect(wrongItemKindFromText('received wrong shirt color and print color')).toBe('wrong_color');
    expect(
      wrongItemKindFromText(
        null,
        'Customer ordered red Crimson shirt but received gray instead - needs the right one.'
      )
    ).toBe('wrong_color');
  });

  it('reads a wrong design, including "instead of"', () => {
    expect(wrongItemKindFromText('received wrong design')).toBe('wrong_design');
    expect(wrongItemKindFromText('received Wanted/Arlo shirt instead of Surrender')).toBe('wrong_design');
    expect(
      wrongItemKindFromText('Customer ordered Surrender but received Wanted/Arlo instead.')
    ).toBe('wrong_design');
    expect(
      wrongItemKindFromText(
        'Customer ordered one t-shirt but order receipt shows three different designs than what was agreed to.'
      )
    ).toBe('wrong_design');
  });

  it('is not fooled by a size or a color named in passing', () => {
    // "wrong design instead of Surrender tee in Military Green size M" names a
    // color and a size, and neither is what went wrong.
    expect(
      wrongItemKindFromText(
        'Received wrong design instead of Surrender tee in Military Green size M.'
      )
    ).toBe('wrong_design');
  });

  it('reads a missing shirt before anything else', () => {
    expect(wrongItemKindFromText('missing one shirt from order')).toBe('missing_item');
    expect(wrongItemKindFromText('Missing one shirt from order')).toBe('missing_item');
    expect(
      wrongItemKindFromText('Customer did not receive one shirt from the order - the Retired one.')
    ).toBe('missing_item');
  });

  it('reads a wrong size', () => {
    expect(wrongItemKindFromText('received wrong size')).toBe('wrong_size');
    expect(wrongItemKindFromText('size was wrong, got a medium instead of large')).toBe('wrong_size');
  });

  it('reads an extra item', () => {
    expect(wrongItemKindFromText('extra shirt in the parcel they did not order')).toBe('extra_item');
  });

  it('says other when the words give nothing away', () => {
    expect(wrongItemKindFromText('order problem')).toBe('other');
    expect(wrongItemKindFromText(null, undefined, '')).toBe('other');
  });
});

describe('isWrongItemKind', () => {
  it('accepts the six kinds and nothing else', () => {
    expect(isWrongItemKind('wrong_color')).toBe(true);
    expect(isWrongItemKind('missing_item')).toBe(true);
    expect(isWrongItemKind('wrong colour')).toBe(false);
    expect(isWrongItemKind(null)).toBe(false);
  });
});
