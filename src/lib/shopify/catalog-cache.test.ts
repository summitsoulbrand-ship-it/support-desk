import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ShopifyClient, clearCatalogCaches, PRODUCT_DETAILS_TTL_MS } from './client';

/** A fake Shopify that records every query and answers from `products`. */
function fakeShopify(products: Record<string, { status?: string } | undefined>) {
  const queries: string[] = [];
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body);
    queries.push(variables?.query ?? query);
    if (query.includes('primaryDomain')) {
      return {
        ok: true,
        headers: new Headers(),
        json: async () => ({ data: { shop: { primaryDomain: { url: 'https://summitsoul.shop/' } } } }),
      };
    }
    const asked = [...String(variables.query).matchAll(/handle:([^\s]+)/g)].map((m) => m[1]);
    return {
      ok: true,
      headers: new Headers(),
      json: async () => ({
        data: {
          products: {
            nodes: asked
              .filter((h) => products[h])
              .map((h) => ({
                title: `Title ${h}`,
                handle: h,
                productType: 'T-Shirt',
                status: products[h]!.status ?? 'ACTIVE',
                options: [
                  { name: 'Color', optionValues: [{ name: 'Berry' }] },
                  { name: 'Size', optionValues: [{ name: 'S' }, { name: 'M' }] },
                ],
                priceRangeV2: {
                  minVariantPrice: { amount: '29.95' },
                  maxVariantPrice: { amount: '33.95' },
                },
              })),
          },
        },
      }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, queries };
}

const client = () =>
  new ShopifyClient({ storeDomain: 'example.myshopify.com', accessToken: 't' } as never);

describe('catalog caches', () => {
  beforeEach(() => clearCatalogCaches());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('asks Shopify once, then serves the same products from the cache', async () => {
    const { fetchMock } = fakeShopify({ a: {}, b: {} });
    const first = await client().getProductsByHandles(['a', 'b']);
    const second = await client().getProductsByHandles(['b', 'a']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.map((p) => p.handle)).toEqual(['a', 'b']);
    // The caller's order is kept, even from the cache.
    expect(second.map((p) => p.handle)).toEqual(['b', 'a']);
    expect(second[0]).toMatchObject({ colors: ['Berry'], sizes: ['S', 'M'], priceRange: '$29.95-$33.95' });
  });

  it('asks only for the products it does not have yet', async () => {
    const { fetchMock, queries } = fakeShopify({ a: {}, c: {} });
    await client().getProductsByHandles(['a']);
    await client().getProductsByHandles(['a', 'c']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(queries[1]).toBe('handle:c');
  });

  it('remembers a product that is gone or not active, and never returns it', async () => {
    const { fetchMock } = fakeShopify({ a: {}, old: { status: 'ARCHIVED' } });
    expect((await client().getProductsByHandles(['a', 'old', 'gone'])).map((p) => p.handle)).toEqual(['a']);
    expect((await client().getProductsByHandles(['old', 'gone'])).length).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks again once 24 hours have passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
    const { fetchMock } = fakeShopify({ a: {} });
    await client().getProductsByHandles(['a']);
    vi.setSystemTime(new Date(Date.now() + PRODUCT_DETAILS_TTL_MS - 60_000));
    await client().getProductsByHandles(['a']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(Date.now() + 2 * 60_000));
    await client().getProductsByHandles(['a']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed lookup', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await client().getProductsByHandles(['a'])).toEqual([]);
    const { fetchMock } = fakeShopify({ a: {} });
    expect((await client().getProductsByHandles(['a'])).map((p) => p.handle)).toEqual(['a']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads the store address once, and does not keep the fallback after a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await client().getPrimaryDomain()).toBe('https://example.myshopify.com');
    const { fetchMock } = fakeShopify({});
    expect(await client().getPrimaryDomain()).toBe('https://summitsoul.shop');
    expect(await client().getPrimaryDomain()).toBe('https://summitsoul.shop');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
