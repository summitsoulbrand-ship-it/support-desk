import { describe, it, expect } from 'vitest';
import { buildTrackingContext } from './types';
import type { TrackingResult } from '@/lib/trackingmore/client';

/**
 * The carrier's own "left at front door" wording is the single most useful
 * thing we can hand a customer who cannot find a package we show as delivered.
 * It used to be discarded (latestEvent is overwritten with a plain
 * "Delivered <date>" once delivered), and operators typed it back in by hand
 * on every lost-package reply - twice in the 2026-07-19/26 edit digests.
 */
const delivered = (
  events: TrackingResult['events'],
  overrides: Partial<TrackingResult> = {}
): TrackingResult => ({
  trackingNumber: 'TBA332433805168',
  carrier: 'Amazon',
  carrierCode: 'amazon',
  status: 'delivered',
  statusDescription: 'Delivered',
  deliveredAt: '2026-07-09T12:24:00Z',
  shippedAt: '2026-07-06T10:00:00Z',
  lastUpdate: '2026-07-09T12:24:00Z',
  events,
  ...overrides,
});

const detailOf = (tracking: TrackingResult) =>
  buildTrackingContext(tracking).trackingInfo?.deliveryDetail;

describe('deliveryDetail', () => {
  it('keeps the carrier wording for where the package was left', () => {
    expect(
      detailOf(
        delivered([
          { date: '2026-07-09T12:24:00Z', description: 'Left at front door', status: 'delivered' },
        ])
      )
    ).toBe('Left at front door');
  });

  it('appends the location when the carrier gives one', () => {
    expect(
      detailOf(
        delivered([
          {
            date: '2026-07-09T12:24:00Z',
            description: 'Handed directly to a resident',
            location: 'Denver, CO',
            status: 'delivered',
          },
        ])
      )
    ).toBe('Handed directly to a resident (Denver, CO)');
  });

  it('prefers the delivery event over a later non-delivery scan', () => {
    expect(
      detailOf(
        delivered([
          { date: '2026-07-10T09:00:00Z', description: 'Package scanned', status: 'in_transit' },
          { date: '2026-07-09T12:24:00Z', description: 'Left at back porch', status: 'delivered' },
        ])
      )
    ).toBe('Left at back porch');
  });

  it('returns nothing when the carrier only says "Delivered"', () => {
    // A bare status is not a drop location - surfacing it would tell the
    // customer to go look at a spot the carrier never named.
    expect(
      detailOf(
        delivered([
          { date: '2026-07-09T12:24:00Z', description: 'Delivered', status: 'delivered' },
        ])
      )
    ).toBeUndefined();
  });

  it('falls back to the location when the description is a bare status', () => {
    expect(
      detailOf(
        delivered([
          {
            date: '2026-07-09T12:24:00Z',
            description: 'Delivered',
            location: 'Front desk',
            status: 'delivered',
          },
        ])
      )
    ).toBe('Delivered - Front desk');
  });

  it('stays undefined when there are no events at all', () => {
    expect(detailOf(delivered([]))).toBeUndefined();
  });

  it('is not set for a package that has not been delivered', () => {
    const inTransit = delivered(
      [{ date: '2026-07-07T09:00:00Z', description: 'In transit', status: 'in_transit' }],
      { status: 'in_transit', deliveredAt: undefined }
    );
    expect(detailOf(inTransit)).toBeUndefined();
  });
});
