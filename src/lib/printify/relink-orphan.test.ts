/**
 * The #38398 failure (2026-09-11): Printify answered the create slowly, the
 * HTTP client abandoned the request after 20s, and the rebuild concluded the
 * order had not been built. It HAD been. The original was left live alongside
 * it and the customer was one print sweep away from 10 shirts instead of 6.
 *
 * These cover the lookup that now runs before we conclude failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrintifyClient } from './client';

type FakeOrder = { id: string; status: string; external_id?: string; metadata?: Record<string, string> };

function clientWithOrders(pages: FakeOrder[][]) {
  const c = new PrintifyClient({ apiToken: 't', shopId: 's' } as never);
  vi.spyOn(c as never as { listOrders: unknown }, 'listOrders' as never).mockImplementation(
    (async (page: number) => pages[page - 1] ?? []) as never
  );
  return c;
}

describe('findAllByExactExternalId', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('finds the order Printify built while we thought the create failed', async () => {
    const c = clientWithOrders([[
      { id: 'orphan', status: 'on-hold', external_id: '38398-R1789140630562' },
      { id: 'unrelated', status: 'on-hold', external_id: '99999-R1' },
    ]]);
    const hits = await c.findAllByExactExternalId('38398-R1789140630562');
    expect(hits.map((o) => o.id)).toEqual(['orphan']);
  });

  it('matches the id Printify echoes into metadata.shop_order_id', async () => {
    const c = clientWithOrders([[
      { id: 'orphan', status: 'on-hold', metadata: { shop_order_id: '38398-R1789140630562' } },
    ]]);
    const hits = await c.findAllByExactExternalId('38398-R1789140630562');
    expect(hits.map((o) => o.id)).toEqual(['orphan']);
  });

  it('returns EVERY duplicate, because each HTTP retry reuses the same external_id', async () => {
    const c = clientWithOrders([[
      { id: 'dup2', status: 'on-hold', external_id: '38398-R1' },
      { id: 'dup1', status: 'on-hold', external_id: '38398-R1' },
    ]]);
    const hits = await c.findAllByExactExternalId('38398-R1');
    expect(hits.map((o) => o.id)).toEqual(['dup2', 'dup1']);
  });

  it('does NOT grab the other copies that merely share the order name', async () => {
    // The pre-upsell original carries label/shop_order_label #38398. Adopting
    // THAT would cancel the complete order and ship the customer 4 of 6 shirts.
    const c = clientWithOrders([[
      { id: 'original', status: 'on-hold', external_id: '38398', metadata: { shop_order_label: '#38398' } },
    ]]);
    expect(await c.findAllByExactExternalId('38398-R1789140630562')).toEqual([]);
  });

  it('returns nothing when the create genuinely did not happen', async () => {
    const c = clientWithOrders([[{ id: 'other', status: 'on-hold', external_id: '11111-R1' }]]);
    expect(await c.findAllByExactExternalId('38398-R1')).toEqual([]);
  });

  it('throws when the lookup fails, so a caller cannot read it as "nothing was built"', async () => {
    const c = new PrintifyClient({ apiToken: 't', shopId: 's' } as never);
    vi.spyOn(c as never as { listOrders: unknown }, 'listOrders' as never).mockImplementation(
      (() => Promise.reject(new Error('Printify 503'))) as never
    );
    await expect(c.findAllByExactExternalId('38398-R1')).rejects.toThrow();
  });
});
