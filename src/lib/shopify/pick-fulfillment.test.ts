import { describe, it, expect } from 'vitest';
import { pickFulfillmentForTracking } from './pick-fulfillment';

const parcel = (id: string, createdAt: string, lines: [string, string][], status = 'SUCCESS') => ({
  id,
  status,
  createdAt,
  fulfillmentLineItems: {
    nodes: lines.map(([title, variantTitle]) => ({ lineItem: { title, variantTitle } })),
  },
});

// #38075 as Shopify holds it (read 2026-09-24): the same design in two
// parcels. The reprint is the Graphite XL, which is the OLDER parcel.
const split = [
  parcel('newer', '2026-09-11T12:51:00Z', [['Retired and Unsupervised Premium', 'Blue Jean / 2XL']]),
  parcel('older', '2026-09-11T02:24:00Z', [['Retired and Unsupervised Premium', 'Graphite / XL']]),
];

describe('pickFulfillmentForTracking', () => {
  it('puts a reprint on the parcel that held that exact shirt', () => {
    const f = pickFulfillmentForTracking(split, [
      { title: 'Retired and Unsupervised Premium', variantLabel: 'Graphite / XL' },
    ]);
    expect(f?.id).toBe('older');
  });

  it('matches size/color in either order', () => {
    const f = pickFulfillmentForTracking(split, [
      { title: 'Retired and Unsupervised Premium', variantLabel: 'XL / Graphite' },
    ]);
    expect(f?.id).toBe('older');
  });

  it('matches a "Copy of" title from a product duplicated in Printify', () => {
    const f = pickFulfillmentForTracking(
      [
        parcel('a', '2026-09-02T00:00:00Z', [['Surrender', 'Dark Heather / L']]),
        parcel('b', '2026-09-01T00:00:00Z', [['Fluffy Cow Premium', 'Graphite / 2XL']]),
      ],
      [{ title: 'Copy of Fluffy Cow Premium', variantLabel: 'Graphite / 2XL' }]
    );
    expect(f?.id).toBe('b');
  });

  it('falls back to the newest shipped parcel when nothing matches', () => {
    const f = pickFulfillmentForTracking(split, [{ title: 'Some Renamed Shirt', variantLabel: 'M' }]);
    expect(f?.id).toBe('newer');
  });

  it('keeps the old behavior without items: newest shipped parcel', () => {
    expect(pickFulfillmentForTracking(split)?.id).toBe('newer');
  });

  it('never picks a cancelled fulfillment', () => {
    const f = pickFulfillmentForTracking(
      [
        parcel('cancelled', '2026-09-12T00:00:00Z', [['Surrender', 'Dark Heather / L']], 'CANCELLED'),
        parcel('live', '2026-09-01T00:00:00Z', [['Surrender', 'Military Green / M']]),
      ],
      [{ title: 'Surrender', variantLabel: 'Dark Heather / L' }]
    );
    expect(f?.id).toBe('live');
  });

  it('returns nothing when no parcel has shipped', () => {
    expect(pickFulfillmentForTracking([])).toBeUndefined();
  });
});
