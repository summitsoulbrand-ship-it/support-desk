import { describe, it, expect } from 'vitest';
import { needsLiveTracking } from './tracking-relevance';

describe('needsLiveTracking', () => {
  it('always pulls live tracking for a shipping-status intent', () => {
    expect(needsLiveTracking('SHIPPING_STATUS', 'hi')).toBe(true);
  });

  it('pulls live tracking when the customer asks about shipping/arrival/tracking', () => {
    expect(needsLiveTracking('OTHER', 'where is my order?')).toBe(true);
    expect(needsLiveTracking('OTHER', 'when will it arrive?')).toBe(true);
    expect(needsLiveTracking('OTHER', 'has it shipped yet?')).toBe(true);
    expect(needsLiveTracking('OTHER', 'can I get the tracking number')).toBe(true);
    expect(needsLiveTracking('ORDER_ISSUE', "it still hasn't arrived")).toBe(true);
    expect(needsLiveTracking('OTHER', 'I think my package is lost')).toBe(true);
  });

  it('does NOT pull live tracking for non-shipping requests', () => {
    expect(needsLiveTracking('ORDER_ISSUE', 'the shirt is the wrong size')).toBe(false);
    expect(needsLiveTracking('ORDER_ISSUE', 'there is a misprint on the front')).toBe(false);
    expect(needsLiveTracking('PRODUCT_QUESTION', 'is this 100% cotton?')).toBe(false);
    expect(needsLiveTracking('CANCELLATION', 'please cancel my order')).toBe(false);
    expect(needsLiveTracking('OTHER', 'I love it, thank you!')).toBe(false);
    expect(needsLiveTracking('OTHER', '')).toBe(false);
    expect(needsLiveTracking(null, undefined)).toBe(false);
  });
});
