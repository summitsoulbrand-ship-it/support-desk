/**
 * The words a person reads in Slack after an automatic refund did not report
 * success. Get this wrong in one direction and a customer is refunded twice:
 * "refund by hand" is only safe when Shopify definitely refused. Customer money
 * - keep green.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  chargeRefundStatus,
  refundByHandAction,
  refundIsUnconfirmed,
  withdrawalRefundAction,
} from './refund-alert';
import { REFUND_UNCONFIRMED_WARNING } from '@/lib/shopify/idempotency';
import { ShopifyClient } from '@/lib/shopify/client';

const TIMED_OUT = {
  success: false,
  outcomeUnknown: true,
  errors: ['The operation was aborted due to timeout', REFUND_UNCONFIRMED_WARNING],
};
const REFUSED = { success: false, errors: ['No amount available to refund'] };

/** The look-first instruction has to come BEFORE any mention of refunding by hand. */
function expectLookFirst(text: string, byHand: string) {
  expect(text).toContain('UNCONFIRMED');
  expect(text).toContain('may or may not have gone through');
  expect(text).toContain('open the order in Shopify and check whether');
  expect(text).toContain('is already there');
  const look = text.indexOf('open the order in Shopify');
  const refund = text.indexOf(byHand);
  expect(refund).toBeGreaterThan(-1);
  expect(look).toBeLessThan(refund);
}

describe('refundIsUnconfirmed', () => {
  it('follows the outcomeUnknown flag', () => {
    expect(refundIsUnconfirmed(TIMED_OUT)).toBe(true);
    expect(refundIsUnconfirmed(REFUSED)).toBe(false);
    expect(refundIsUnconfirmed({ success: false })).toBe(false);
  });

  it('the warning sentence alone is enough - a lost flag must not read as a clean failure', () => {
    expect(refundIsUnconfirmed({ success: false, errors: [REFUND_UNCONFIRMED_WARNING] })).toBe(true);
    expect(
      refundIsUnconfirmed({ success: false, errors: [`Bad Gateway; ${REFUND_UNCONFIRMED_WARNING}`] })
    ).toBe(true);
  });

  it('a refund that succeeded is never unconfirmed', () => {
    expect(refundIsUnconfirmed({ success: true, outcomeUnknown: true })).toBe(false);
  });
});

describe('chargeRefundStatus (payment watcher, production slipped in)', () => {
  it('done is done', () => {
    expect(chargeRefundStatus({ success: true }, '5.00')).toBe('DONE');
  });

  it('UNCONFIRMED: look at the order first, refund by hand only if it is missing', () => {
    const text = chargeRefundStatus(TIMED_OUT, '5.00');
    expectLookFirst(text, 'refund 5.00 by hand ONLY if it is not');
    expect(text).toContain('a refund of 5.00 is already there');
    // The old wording, which is what gets a customer refunded twice.
    expect(text).not.toContain('FAILED');
  });

  it('a definite failure keeps the old wording and adds the reason', () => {
    expect(chargeRefundStatus(REFUSED, '5.00')).toBe(
      'FAILED - refund 5.00 by hand (reason: No amount available to refund)'
    );
    expect(
      chargeRefundStatus({ success: false, errors: ['Order does not exist', ' second thing '] }, '5.00')
    ).toBe('FAILED - refund 5.00 by hand (reason: Order does not exist; second thing)');
  });

  it('no reason available: exactly the wording from before this change', () => {
    expect(chargeRefundStatus({ success: false }, '5.00')).toBe('FAILED - refund 5.00 by hand');
    expect(chargeRefundStatus({ success: false, errors: [] }, '5.00')).toBe('FAILED - refund 5.00 by hand');
    expect(chargeRefundStatus({ success: false, errors: ['  '] }, '5.00')).toBe('FAILED - refund 5.00 by hand');
  });

  it('a page-long Shopify error body is cut so the alert stays readable', () => {
    const text = chargeRefundStatus({ success: false, errors: ['x'.repeat(5000)] }, '5.00');
    expect(text.startsWith('FAILED - refund 5.00 by hand (reason: xxx')).toBe(true);
    expect(text.endsWith('...)')).toBe(true);
    expect(text.length).toBeLessThan(400);
  });

  it('reads as one sentence inside the full alert', () => {
    const alert = (status: string) =>
      `Order #1001 prints the ORIGINALS. Charge refund ${status}; Shopify revert done. Intended: Tee: M -> L.`;
    expect(alert(chargeRefundStatus({ success: true }, '5.00'))).toBe(
      'Order #1001 prints the ORIGINALS. Charge refund DONE; Shopify revert done. Intended: Tee: M -> L.'
    );
    expect(alert(chargeRefundStatus(TIMED_OUT, '5.00'))).toBe(
      'Order #1001 prints the ORIGINALS. Charge refund UNCONFIRMED - Shopify did not confirm it, so it may or may ' +
        'not have gone through. BEFORE refunding by hand, open the order in Shopify and check whether a refund of ' +
        '5.00 is already there, and refund 5.00 by hand ONLY if it is not; Shopify revert done. Intended: Tee: M -> L.'
    );
  });
});

describe('refundByHandAction (item change, net cheaper)', () => {
  it('a definite failure is exactly the wording from before this change', () => {
    expect(refundByHandAction(REFUSED, '5.00 USD')).toBe('Refund 5.00 USD by hand.');
  });

  it('UNCONFIRMED: never a flat "refund by hand"', () => {
    const text = refundByHandAction(TIMED_OUT, '5.00 USD');
    expectLookFirst(text, 'refund 5.00 USD by hand ONLY if it is not');
    expect(text).not.toContain('Refund 5.00 USD by hand.');
  });
});

describe('withdrawalRefundAction (EU withdrawal, full refund)', () => {
  const BEFORE =
    'EU withdrawal was requested but the refund did NOT go through. If the customer does not retry, issue the full refund by hand - the 14-day right stands regardless.';

  it('a definite failure is exactly the wording from before this change', () => {
    expect(withdrawalRefundAction(REFUSED)).toBe(BEFORE);
    // The cancel + refund path has no "unconfirmed" notion and reports this way.
    expect(withdrawalRefundAction({ success: false, outcomeUnknown: false, errors: undefined })).toBe(BEFORE);
  });

  it('UNCONFIRMED: does not claim the refund failed, and says look first', () => {
    const text = withdrawalRefundAction(TIMED_OUT);
    expectLookFirst(text, 'issue the full refund by hand');
    expect(text).not.toContain('did NOT go through');
    expect(text).toContain('the 14-day right stands regardless');
  });
});

/**
 * The same wording, fed by what ShopifyClient.refundOrder REALLY returns. The
 * cases above are hand-built; if refundOrder ever stops marking a timeout the
 * way this file expects, only these catch it.
 */
describe('against the real refundOrder', () => {
  afterEach(() => vi.unstubAllGlobals());

  const ORDER = 'gid://shopify/Order/1001';

  /** A fake Shopify: answers the transactions read, then the refund as told. */
  function fakeShopify(refund: () => unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const { query } = JSON.parse(init.body);
        if (query.includes('RefundCreate')) return refund();
        return {
          ok: true,
          headers: new Headers(),
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
  }

  const refundFive = () =>
    new ShopifyClient({ storeDomain: 'example.myshopify.com', accessToken: 't' } as never).refundOrder(ORDER, {
      amount: '5.00',
      idempotency: { action: 'paid-change-production-slip-refund', nonce: 'row-1' },
    });

  const answer = (body: unknown, status = 200) => () => ({
    ok: status < 400,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });

  it('a timeout reads UNCONFIRMED in all three alerts, and carries the warning the routes put on the Error line', async () => {
    fakeShopify(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const res = await refundFive();

    expectLookFirst(chargeRefundStatus(res, '5.00'), 'refund 5.00 by hand ONLY if it is not');
    expectLookFirst(refundByHandAction(res, '5.00 USD'), 'refund 5.00 USD by hand ONLY if it is not');
    expectLookFirst(withdrawalRefundAction(res), 'issue the full refund by hand');
    // item-change and withdraw build their Error line as errors.join('; ').
    expect(res.errors?.join('; ')).toContain(REFUND_UNCONFIRMED_WARNING);
  });

  it('a 502 from Shopify reads UNCONFIRMED', async () => {
    fakeShopify(answer('Bad Gateway', 502));
    const text = chargeRefundStatus(await refundFive(), '5.00');
    expectLookFirst(text, 'refund 5.00 by hand ONLY if it is not');
    expect(text).not.toContain('FAILED');
  });

  it("'this refund is still in progress' reads UNCONFIRMED", async () => {
    fakeShopify(
      answer({
        data: {
          refundCreate: {
            refund: null,
            userErrors: [{ field: null, message: 'This request is currently in progress, please try again.' }],
          },
        },
      })
    );
    const text = chargeRefundStatus(await refundFive(), '5.00');
    expectLookFirst(text, 'refund 5.00 by hand ONLY if it is not');
    expect(text).not.toContain('FAILED');
  });

  it('a refusal from Shopify reads FAILED, with the reason Shopify gave', async () => {
    fakeShopify(
      answer({
        data: { refundCreate: { refund: null, userErrors: [{ field: ['orderId'], message: 'Order does not exist' }] } },
      })
    );
    expect(chargeRefundStatus(await refundFive(), '5.00')).toBe(
      'FAILED - refund 5.00 by hand (reason: Order does not exist)'
    );
  });

  it('a refund that went through reads DONE', async () => {
    fakeShopify(
      answer({
        data: {
          refundCreate: {
            refund: { id: 'gid://shopify/Refund/1', totalRefundedSet: { shopMoney: { amount: '5.00', currencyCode: 'USD' } } },
            userErrors: [],
          },
        },
      })
    );
    expect(chargeRefundStatus(await refundFive(), '5.00')).toBe('DONE');
  });
});
