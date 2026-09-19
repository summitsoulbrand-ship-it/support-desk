/**
 * Refund idempotency. From Admin API 2026-04 Shopify refuses a refund without a
 * key, and a key only prevents a double refund if a RETRY of the same refund
 * carries the same one. Every case here is customer money - keep green.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isIdempotencyConflict, refundIdempotencyKey, refundOutcomeUnknown } from './idempotency';
import { ShopifyClient } from './client';
import { REFUND_CREATE_MUTATION } from './queries';

const ORDER = 'gid://shopify/Order/1001';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('refundIdempotencyKey', () => {
  const base = { action: 'agent-refund', nonce: 'nonce-1' };

  it('is the SAME key for a retry of the same refund', () => {
    const a = refundIdempotencyKey(ORDER, base, { amount: '5.00' });
    const b = refundIdempotencyKey(ORDER, base, { amount: '5.00' });
    expect(a).toBe(b);
    expect(a).toMatch(UUID);
  });

  it('is a different key for a different nonce, order, flow or amount', () => {
    const key = refundIdempotencyKey(ORDER, base, { amount: '5.00' });
    expect(refundIdempotencyKey(ORDER, { ...base, nonce: 'nonce-2' }, { amount: '5.00' })).not.toBe(key);
    expect(refundIdempotencyKey('gid://shopify/Order/1002', base, { amount: '5.00' })).not.toBe(key);
    expect(refundIdempotencyKey(ORDER, { ...base, action: 'discount-adjustment' }, { amount: '5.00' })).not.toBe(key);
    expect(refundIdempotencyKey(ORDER, base, { amount: '6.00' })).not.toBe(key);
  });

  it('tells a card refund from store credit, and shipping from no shipping', () => {
    const card = refundIdempotencyKey(ORDER, base, { amount: '5.00' });
    expect(refundIdempotencyKey(ORDER, base, { amount: '5.00', refundMethod: 'STORE_CREDIT' })).not.toBe(card);
    expect(refundIdempotencyKey(ORDER, base, { amount: '5.00', refundShipping: true })).not.toBe(card);
    expect(
      refundIdempotencyKey(ORDER, base, { amount: '5.00', refundShipping: true, shippingAmount: '4.95' })
    ).not.toBe(refundIdempotencyKey(ORDER, base, { amount: '5.00', refundShipping: true }));
  });

  it('treats 5, 5.0 and 5.00 as one refund, and an explicit ORIGINAL as the default', () => {
    const key = refundIdempotencyKey(ORDER, base, { amount: '5.00' });
    expect(refundIdempotencyKey(ORDER, base, { amount: '5' })).toBe(key);
    expect(refundIdempotencyKey(ORDER, base, { amount: '5.0', refundMethod: 'ORIGINAL' })).toBe(key);
  });

  it('ignores a shipping amount when shipping is not being refunded', () => {
    const key = refundIdempotencyKey(ORDER, base, { amount: '5.00' });
    expect(
      refundIdempotencyKey(ORDER, base, { amount: '5.00', refundShipping: false, shippingAmount: '4.95' })
    ).toBe(key);
  });

  it('a blank nonce never produces a shared key (that would swallow a second real refund)', () => {
    for (const nonce of [undefined, null, '', '   ']) {
      const a = refundIdempotencyKey(ORDER, { action: 'agent-refund', nonce }, { amount: '5.00' });
      const b = refundIdempotencyKey(ORDER, { action: 'agent-refund', nonce }, { amount: '5.00' });
      expect(a).toMatch(UUID);
      expect(a).not.toBe(b);
    }
  });

  it('is never empty - Shopify rejects an empty or whitespace key outright', () => {
    expect(refundIdempotencyKey(ORDER, base).trim().length).toBeGreaterThan(0);
    expect(refundIdempotencyKey('', { action: '', nonce: 'x' }).trim().length).toBeGreaterThan(0);
  });
});

describe('refundOutcomeUnknown', () => {
  it('a timeout or dropped connection leaves the outcome unknown', () => {
    expect(refundOutcomeUnknown(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe(true);
    expect(refundOutcomeUnknown(new TypeError('fetch failed'))).toBe(true);
    expect(refundOutcomeUnknown(new SyntaxError('Unexpected end of JSON input'))).toBe(true);
  });

  it('a 5xx leaves it unknown, a 4xx is a refusal', () => {
    expect(refundOutcomeUnknown(new Error('Shopify API error: 502 - Bad Gateway'))).toBe(true);
    expect(refundOutcomeUnknown(new Error('Shopify API error: 503 - '))).toBe(true);
    expect(refundOutcomeUnknown(new Error('Shopify API error: 429 - Too Many Requests'))).toBe(false);
    expect(refundOutcomeUnknown(new Error('Shopify API error: 401 - Unauthorized'))).toBe(false);
  });

  it('a GraphQL refusal moved no money; an internal error might have', () => {
    const refused =
      'GraphQL errors: [{"message":"The @idempotent directive is required for this mutation but was not provided.","extensions":{"code":"BAD_REQUEST"}}]';
    expect(refundOutcomeUnknown(new Error(refused))).toBe(false);
    expect(refundOutcomeUnknown(new Error('GraphQL errors: [{"message":"Throttled","extensions":{"code":"THROTTLED"}}]'))).toBe(false);
    expect(
      refundOutcomeUnknown(new Error('GraphQL errors: [{"message":"Internal error","extensions":{"code":"INTERNAL_SERVER_ERROR"}}]'))
    ).toBe(true);
  });
});

describe('isIdempotencyConflict', () => {
  it("recognises Shopify's two documented 'already seen this key' answers", () => {
    expect(isIdempotencyConflict('This request is currently in progress, please try again.')).toBe(true);
    expect(
      isIdempotencyConflict('The same idempotency key cannot be used with different operation parameters.')
    ).toBe(true);
  });

  it('leaves ordinary refusals alone', () => {
    expect(isIdempotencyConflict('Order does not exist')).toBe(false);
    expect(isIdempotencyConflict('Refund amount exceeds the refundable amount')).toBe(false);
    expect(isIdempotencyConflict('')).toBe(false);
  });
});

describe('the refund mutation text', () => {
  it('carries the directive on the mutation FIELD, fed by a variable', () => {
    expect(REFUND_CREATE_MUTATION).toMatch(/\$idempotencyKey:\s*String!/);
    expect(REFUND_CREATE_MUTATION).toMatch(/refundCreate\(input:\s*\$input\)\s*@idempotent\(key:\s*\$idempotencyKey\)/);
  });

  it('no refundCreate anywhere in the Shopify client goes out without it', () => {
    let found = 0;
    for (const file of ['queries.ts', 'client.ts']) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
      const calls = source.match(/refundCreate\s*\([^)]*\)[^{]*\{/g) || [];
      found += calls.length;
      for (const call of calls) expect(call).toContain('@idempotent');
    }
    // Finding none would make this check pass while checking nothing.
    expect(found).toBeGreaterThan(0);
  });
});

describe('ShopifyClient.refundOrder', () => {
  afterEach(() => vi.unstubAllGlobals());

  type Sent = { url: string; query: string; variables: Record<string, unknown> };

  /** A fake Shopify: answers the transactions read, then the refund as told. */
  function fakeShopify(refund: () => unknown) {
    const sent: Sent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        const { query, variables } = JSON.parse(init.body);
        sent.push({ url, query, variables });
        if (query.includes('RefundCreate')) return refund();
        return {
          ok: true,
          json: async () => ({
            data: {
              order: {
                id: ORDER,
                name: '#1001',
                totalReceivedSet: { shopMoney: { amount: '44.00', currencyCode: 'USD' } },
                totalRefundedSet: { shopMoney: { amount: '0.00', currencyCode: 'USD' } },
                transactions: [
                  {
                    id: 'gid://shopify/OrderTransaction/1',
                    kind: 'SALE',
                    status: 'SUCCESS',
                    amountSet: { shopMoney: { amount: '44.00', currencyCode: 'USD' } },
                    gateway: 'shopify_payments',
                  },
                ],
              },
            },
          }),
        };
      })
    );
    const refunds = () => sent.filter((s) => s.query.includes('RefundCreate'));
    return { sent, refunds };
  }

  const ok = (amount: string) => () => ({
    ok: true,
    json: async () => ({
      data: {
        refundCreate: {
          refund: { id: 'gid://shopify/Refund/1', totalRefundedSet: { shopMoney: { amount, currencyCode: 'USD' } } },
          userErrors: [],
        },
      },
    }),
  });

  const client = () => new ShopifyClient({ storeDomain: 'example.myshopify.com', accessToken: 't' } as never);
  const idempotency = { action: 'agent-refund', nonce: 'nonce-1' };

  it('sends the key with the refund, on an API version that knows the directive', async () => {
    const shop = fakeShopify(ok('5.00'));
    const res = await client().refundOrder(ORDER, { amount: '5.00', idempotency });

    expect(res.success).toBe(true);
    const [refund] = shop.refunds();
    expect(refund.query).toContain('@idempotent(key: $idempotencyKey)');
    expect(refund.variables.idempotencyKey).toBe(refundIdempotencyKey(ORDER, idempotency, { amount: '5.00' }));
    expect(refund.variables.idempotencyKey).toMatch(UUID);

    // @idempotent does not exist before 2026-01: an older pin rejects EVERY refund.
    const version = refund.url.match(/\/admin\/api\/(\d{4}-\d{2})\//)?.[1] ?? '';
    expect(version >= '2026-01').toBe(true);
  });

  it('a retry of the same refund repeats the key; a new refund gets a new one', async () => {
    const shop = fakeShopify(ok('5.00'));
    await client().refundOrder(ORDER, { amount: '5.00', idempotency });
    await client().refundOrder(ORDER, { amount: '5.00', reason: 'edited the note', idempotency });
    await client().refundOrder(ORDER, { amount: '5.00', idempotency: { ...idempotency, nonce: 'nonce-2' } });

    const keys = shop.refunds().map((r) => r.variables.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('a timeout is reported as outcome UNKNOWN, with a warning the agent can read', async () => {
    fakeShopify(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const res = await client().refundOrder(ORDER, { amount: '5.00', idempotency });

    expect(res.success).toBe(false);
    expect(res.outcomeUnknown).toBe(true);
    expect(res.errors?.join(' ')).toContain('may or may not have gone through');
  });

  it('a refusal from Shopify is NOT unknown - nothing moved', async () => {
    fakeShopify(() => ({
      ok: true,
      json: async () => ({
        errors: [
          {
            message: 'The @idempotent directive is required for this mutation but was not provided.',
            extensions: { code: 'BAD_REQUEST' },
          },
        ],
      }),
    }));
    const refused = await client().refundOrder(ORDER, { amount: '5.00', idempotency });
    expect(refused.success).toBe(false);
    expect(refused.outcomeUnknown).toBe(false);

    fakeShopify(() => ({
      ok: true,
      json: async () => ({
        data: { refundCreate: { refund: null, userErrors: [{ field: ['orderId'], message: 'Order does not exist' }] } },
      }),
    }));
    const userError = await client().refundOrder(ORDER, { amount: '5.00', idempotency });
    expect(userError.success).toBe(false);
    expect(userError.outcomeUnknown).toBeFalsy();
    expect(userError.errors).toEqual(['Order does not exist']);
  });

  it("'this key is still in progress' keeps the outcome UNKNOWN, so the key is not replaced", async () => {
    fakeShopify(() => ({
      ok: true,
      json: async () => ({
        data: {
          refundCreate: {
            refund: null,
            userErrors: [{ field: null, message: 'This request is currently in progress, please try again.' }],
          },
        },
      }),
    }));
    const res = await client().refundOrder(ORDER, { amount: '5.00', idempotency });

    expect(res.success).toBe(false);
    expect(res.outcomeUnknown).toBe(true);
    expect(res.errors?.join(' ')).toContain('may or may not have gone through');
  });
});
