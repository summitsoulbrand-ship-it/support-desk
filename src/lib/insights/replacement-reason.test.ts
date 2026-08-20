import { describe, it, expect } from 'vitest';
import {
  detectReplacementReason,
  customerWordsOnly,
  hasReasonTag,
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
      expect(detectReplacementReason(text)?.tag, text).toBe('neck');
    }
  });

  it('does not read a v-neck product name as a neck complaint', () => {
    const text = "I'd like to exchange it for a size Medium Heather Mauve V neck.";
    expect(detectReplacementReason(text)?.tag).not.toBe('neck');
  });

  it('separates a lost parcel from a product failure', () => {
    const cases = [
      'Shirt was never delivered. Says on its way for days.',
      'I never received this order. Can you please resend',
      'The package has not been delivered. Delivery Failed',
      'it was delivered to the wrong address',
    ];
    for (const text of cases) {
      expect(detectReplacementReason(text)?.tag, text).toBe('not delivered');
    }
  });

  it('catches print and damage problems', () => {
    expect(detectReplacementReason('the item arrived damaged')?.tag).toBe('defect');
    expect(
      detectReplacementReason('the print is crooked and off center')?.tag
    ).toBe('defect');
    expect(detectReplacementReason('there is a hole in the shirt')?.tag).toBe(
      'defect'
    );
  });

  it('picks up the size direction the customer states in words', () => {
    expect(
      detectReplacementReason('I should have ordered a medium. It is hard to tell sizes')?.tag
    ).toBe('too big');
    expect(
      detectReplacementReason('the XL is a little baggy on me')?.tag
    ).toBe('too big');
    expect(
      detectReplacementReason('I would like to go up to Medium/M')?.tag
    ).toBe('too small');
    expect(detectReplacementReason('it runs small')?.tag).toBe('too small');
  });

  it('prefers the specific reason when a message carries both', () => {
    // Neck beats a bare size direction: it is the actionable complaint.
    const text = 'The shirt fits fine but the neck is too tight, can I size up?';
    expect(detectReplacementReason(text)?.tag).toBe('neck');
    // A lost parcel beats everything - there is no garment to judge.
    expect(
      detectReplacementReason('My package was never delivered, and the last one ran small')?.tag
    ).toBe('not delivered');
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
    expect(detectReplacementReason(trimmed)?.tag).toBe('neck');
  });
});

describe('hasReasonTag', () => {
  it('is true only when a reason is already recorded', () => {
    expect(hasReasonTag(['Replacement', 'Size Exchange'])).toBe(false);
    expect(hasReasonTag(['Replacement', 'Size Exchange', 'too big'])).toBe(true);
    expect(hasReasonTag(['Replacement', ' Neck '])).toBe(true);
  });
});
