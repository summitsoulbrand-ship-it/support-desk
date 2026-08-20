import { describe, it, expect } from 'vitest';
import {
  detectReplacementReason,
  customerWordsOnly,
  hasReasonTag,
  canonicalReasonFrom,
  REASON,
} from './replacement-reason';

/**
 * Every string here is taken from a real customer thread (the wording, not the
 * name), so the rules stay tied to how people actually write in.
 */
describe('detectReplacementReason', () => {
  it('reads the neck complaint that drives people to the v-neck', () => {
    const cases = [
      "Love my shirt but the neck is too tight. Rest of the shirt fits great.",
      "the neck hole was so small I could barely get it on",
      "the neck opening is very small & snug. It's not comfortable",
      "I ended up cutting out the neck to wear it comfortably",
      'the collar is very high and tight',
    ];
    for (const text of cases) {
      expect(detectReplacementReason(text)?.tag, text).toBe(REASON.NECK);
    }
  });

  it('does not read a v-neck product name as a neck complaint', () => {
    const text = "I'd like to exchange it for a size Medium Heather Mauve V neck.";
    expect(detectReplacementReason(text)?.tag).not.toBe(REASON.NECK);
  });

  it('separates a lost parcel from a product failure', () => {
    const cases = [
      'Shirt was never delivered. Says on its way for days.',
      'I never received this order. Can you please resend',
      'The package has not been delivered. Delivery Failed',
      'it was delivered to the wrong address',
    ];
    for (const text of cases) {
      expect(detectReplacementReason(text)?.tag, text).toBe(REASON.NOT_DELIVERED);
    }
  });

  it('catches print and damage problems', () => {
    expect(detectReplacementReason('the item arrived damaged')?.tag).toBe(REASON.DEFECT);
    expect(
      detectReplacementReason('the print is crooked and off center')?.tag
    ).toBe(REASON.PRINT);
    expect(detectReplacementReason('there is a hole in the shirt')?.tag).toBe(
      REASON.DEFECT
    );
  });

  it('picks up the size direction the customer states in words', () => {
    expect(
      detectReplacementReason('I should have ordered a medium. It is hard to tell sizes')?.tag
    ).toBe(REASON.TOO_BIG);
    expect(
      detectReplacementReason('the XL is a little baggy on me')?.tag
    ).toBe(REASON.TOO_BIG);
    expect(
      detectReplacementReason('I would like to go up to Medium/M')?.tag
    ).toBe(REASON.TOO_SMALL);
    expect(detectReplacementReason('it runs small')?.tag).toBe(REASON.TOO_SMALL);
  });

  it('prefers the specific reason when a message carries both', () => {
    // Neck beats a bare size direction: it is the actionable complaint.
    const text = 'The shirt fits fine but the neck is too tight, can I size up?';
    expect(detectReplacementReason(text)?.tag).toBe(REASON.NECK);
    // A lost parcel beats everything - there is no garment to judge.
    expect(
      detectReplacementReason('My package was never delivered, and the last one ran small')?.tag
    ).toBe(REASON.NOT_DELIVERED);
  });

  it('returns null when the customer never said why', () => {
    expect(detectReplacementReason('Replacement please')).toBeNull();
    expect(detectReplacementReason('Please assist with my return')).toBeNull();
    expect(detectReplacementReason('')).toBeNull();
  });

  it('reports the phrase that triggered the tag', () => {
    const hit = detectReplacementReason('the neck is too tight on this one');
    expect(hit?.phrase).toContain('neck is too tight');
  });
});

describe('customerWordsOnly', () => {
  it('drops the quoted reply chain so our words are not read as theirs', () => {
    const body =
      "The neck is too tight.\nOn Mon, Aug 17, 2026 at 1:34 PM Summit Soul wrote:\n> sorry the print was crooked";
    const trimmed = customerWordsOnly(body);
    expect(trimmed).toBe('The neck is too tight.');
    expect(detectReplacementReason(trimmed)?.tag).toBe(REASON.NECK);
  });
});

describe('hasReasonTag', () => {
  it('is true only when a reason is already recorded', () => {
    expect(hasReasonTag(['Replacement', 'Size Exchange'])).toBe(false);
    expect(hasReasonTag(['Replacement', 'Size Exchange', 'too big'])).toBe(true);
    expect(hasReasonTag(['Replacement', 'reason:neck'])).toBe(true);
    expect(hasReasonTag(['Replacement', ' Neck '])).toBe(true);
  });
});

describe('print is its own reason, not lumped with damage', () => {
  it('reads print quality and placement complaints', () => {
    const cases = [
      'the print is crooked and off center',
      'the design is faded already',
      'the graphic is peeling after one wash',
      'the print placement is off',
    ];
    for (const text of cases) {
      expect(detectReplacementReason(text)?.tag, text).toBe(REASON.PRINT);
    }
  });

  it('keeps physical damage separate', () => {
    expect(detectReplacementReason('there is a hole in the shirt')?.tag).toBe(
      REASON.DEFECT
    );
    expect(detectReplacementReason('the item arrived damaged')?.tag).toBe(
      REASON.DEFECT
    );
  });
});

describe('canonicalReasonFrom', () => {
  it('folds every spelling seen on a real order into one tag', () => {
    // These are the exact strings found on live replacement orders.
    expect(canonicalReasonFrom(['Too small'])).toBe(REASON.TOO_SMALL);
    expect(canonicalReasonFrom(['too small'])).toBe(REASON.TOO_SMALL);
    expect(canonicalReasonFrom(['Too large'])).toBe(REASON.TOO_BIG);
    expect(canonicalReasonFrom(['too big'])).toBe(REASON.TOO_BIG);
    // 'print' was on 21 orders and matched no rule before, so every one of
    // them was counted as Unspecified.
    expect(canonicalReasonFrom(['print'])).toBe(REASON.PRINT);
    expect(canonicalReasonFrom(['wrong print'])).toBe(REASON.PRINT);
    expect(canonicalReasonFrom(['print placement'])).toBe(REASON.PRINT);
    expect(canonicalReasonFrom(['lost'])).toBe(REASON.NOT_DELIVERED);
    expect(canonicalReasonFrom(['Color change'])).toBe(REASON.COLOR);
    expect(canonicalReasonFrom(['quality'])).toBe(REASON.DEFECT);
  });

  it('prefers a canonical tag over a legacy one on the same order', () => {
    expect(canonicalReasonFrom(['too small', 'reason:neck'])).toBe(REASON.NECK);
  });

  it('ignores workflow tags and Printify ids', () => {
    expect(
      canonicalReasonFrom([
        'Replacement',
        'Size Exchange',
        'combined-shipment',
        'p_69af98507948de7782020def',
      ])
    ).toBeNull();
  });
});
