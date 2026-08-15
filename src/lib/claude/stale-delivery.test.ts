import { describe, it, expect } from 'vitest';
import { buildTrackingContext } from './types';
import type { TrackingResult } from '@/lib/trackingmore/client';

/**
 * A "never arrived" message weeks after the delivery scan cannot be answered
 * with the fresh-delivery playbook. Order #17386 (Pati, 2026-08-15) was
 * delivered in June and the draft still asked the customer to have a look
 * around the property and give it a day or two. staleDelivery is the flag that
 * switches the reply to replace-or-refund while still stating the delivery.
 */
const NOW = new Date('2026-08-15T12:00:00Z');

const deliveredOn = (deliveredAt: string): TrackingResult => ({
  trackingNumber: 'TBA331793421787',
  carrier: 'Amazon',
  carrierCode: 'amazon',
  status: 'delivered',
  statusDescription: 'Delivered',
  deliveredAt,
  shippedAt: '2026-06-08T10:00:00Z',
  lastUpdate: deliveredAt,
  events: [{ date: deliveredAt, description: 'Left at front door', status: 'delivered' }],
});

const trackingOf = (tracking: TrackingResult) =>
  buildTrackingContext(tracking, undefined, NOW).trackingInfo;

describe('staleDelivery', () => {
  it('flags a delivery that is weeks old', () => {
    const t = trackingOf(deliveredOn('2026-06-11T15:00:00Z'));
    expect(t?.daysSinceDelivery).toBe(64);
    expect(t?.staleDelivery).toBe(true);
  });

  it('leaves a fresh delivery alone so the check-around advice still runs', () => {
    const t = trackingOf(deliveredOn('2026-08-13T15:00:00Z'));
    expect(t?.daysSinceDelivery).toBe(1);
    expect(t?.staleDelivery).toBe(false);
  });

  it('does not flag the day before the two-week cutoff', () => {
    const t = trackingOf(deliveredOn('2026-08-02T12:00:00Z'));
    expect(t?.daysSinceDelivery).toBe(13);
    expect(t?.staleDelivery).toBe(false);
  });

  it('flags exactly two weeks out', () => {
    const t = trackingOf(deliveredOn('2026-08-01T12:00:00Z'));
    expect(t?.daysSinceDelivery).toBe(14);
    expect(t?.staleDelivery).toBe(true);
  });

  it('keeps the delivery date and drop spot on a stale delivery', () => {
    // The customer still gets told it was marked delivered, and where - the
    // reply says the shirt left us and the delivery went wrong, it just never
    // sends them out to look for it.
    const t = trackingOf(deliveredOn('2026-06-11T15:00:00Z'));
    expect(t?.deliveredAt).toContain('June 11');
    expect(t?.deliveryDetail).toBe('Left at front door');
  });

  it('stays unset for a package that was never delivered', () => {
    const inTransit: TrackingResult = {
      ...deliveredOn('2026-06-11T15:00:00Z'),
      status: 'in_transit',
      deliveredAt: undefined,
      events: [{ date: '2026-06-09T09:00:00Z', description: 'In transit', status: 'in_transit' }],
    };
    const t = trackingOf(inTransit);
    expect(t?.daysSinceDelivery).toBeUndefined();
    expect(t?.staleDelivery).toBe(false);
  });
});
