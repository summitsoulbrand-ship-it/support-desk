/**
 * The words a person reads in Slack after an automatic refund did not report
 * success. Get this wrong in one direction and a customer is refunded twice:
 * "refund by hand" is only safe when Shopify definitely refused. Customer money
 * - keep green.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  chargeRefundStatus,
  preproductionRefundOutcome,
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
 * The support desk's pre-production item change refunds the difference as its
 * LAST step. Until 2026-09-19 a refund that did not succeed was dropped: the
 * agent read "Order changed before production" and the audit line said
 * "refunded" while the customer was still owed the money.
 */
describe('preproductionRefundOutcome (support desk, item change before production)', () => {
  it('a refund that went through reports exactly what the route reported before', () => {
    expect(preproductionRefundOutcome({ success: true, refundedAmount: '5.00' }, '5.00')).toEqual({
      status: 'REFUNDED',
      refundedAmount: '5.00',
      refundWarning: null,
      auditNote: ' (refunded $5.00)',
    });
    // Shopify's own figure wins on screen; without one, the amount we asked for.
    expect(preproductionRefundOutcome({ success: true, refundedAmount: '4.99' }, '5.00').refundedAmount).toBe('4.99');
    expect(preproductionRefundOutcome({ success: true }, '5.00').refundedAmount).toBe('5.00');
  });

  it('a definite failure: the change is done, the refund is not, refund by hand, and why', () => {
    const out = preproductionRefundOutcome(REFUSED, '5.00');
    expect(out.status).toBe('FAILED');
    expect(out.refundWarning).toBe(
      'The item change is done, but the refund of $5.00 to the customer did NOT go through ' +
        '(reason: No amount available to refund). Refund $5.00 by hand. Do not run the item change again.'
    );
  });

  it('a failed refund is never reported as money refunded', () => {
    const out = preproductionRefundOutcome(REFUSED, '5.00');
    expect(out.refundedAmount).toBeNull();
    expect(out.auditNote).toBe(' (refund of $5.00 FAILED)');
    expect(out.auditNote).not.toContain('refunded');
  });

  it('no reason available: no empty brackets', () => {
    for (const refund of [{ success: false }, { success: false, errors: [] }, { success: false, errors: ['  '] }]) {
      expect(preproductionRefundOutcome(refund, '5.00').refundWarning).toBe(
        'The item change is done, but the refund of $5.00 to the customer did NOT go through. ' +
          'Refund $5.00 by hand. Do not run the item change again.'
      );
    }
  });

  it('a page-long Shopify error body is cut so the warning stays readable', () => {
    const text = preproductionRefundOutcome({ success: false, errors: ['x'.repeat(5000)] }, '5.00').refundWarning ?? '';
    expect(text).toContain('(reason: xxx');
    expect(text).toContain('...). Refund $5.00 by hand.');
    expect(text.length).toBeLessThan(500);
  });

  it('UNCONFIRMED: look at the order first, never a flat "refund by hand"', () => {
    const out = preproductionRefundOutcome(TIMED_OUT, '5.00');
    expect(out.status).toBe('UNCONFIRMED');
    const text = out.refundWarning ?? '';
    expectLookFirst(text, 'refund $5.00 by hand ONLY if it is not');
    expect(text).toContain('The item change is done');
    expect(text).toContain('a refund of $5.00 is already there');
    expect(text).toContain('Do not run the item change again.');
    // The definite-failure wording is what gets a customer refunded twice here.
    expect(text).not.toContain('did NOT go through');
    expect(text).not.toContain('Refund $5.00 by hand.');
  });

  it('an unconfirmed refund is neither "refunded" nor "FAILED" in the audit line', () => {
    const out = preproductionRefundOutcome(TIMED_OUT, '5.00');
    expect(out.refundedAmount).toBeNull();
    expect(out.auditNote).toBe(' (refund of $5.00 UNCONFIRMED)');
  });

  it('a lost flag still reads UNCONFIRMED - the warning sentence alone is enough', () => {
    const out = preproductionRefundOutcome({ success: false, errors: [`Bad Gateway; ${REFUND_UNCONFIRMED_WARNING}`] }, '5.00');
    expect(out.status).toBe('UNCONFIRMED');
    expect(out.auditNote).toBe(' (refund of $5.00 UNCONFIRMED)');
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

  it('desk item change: a timeout and a 502 are UNCONFIRMED, on screen and in the audit line', async () => {
    fakeShopify(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const timedOut = preproductionRefundOutcome(await refundFive(), '5.00');
    expect(timedOut.status).toBe('UNCONFIRMED');
    expectLookFirst(timedOut.refundWarning ?? '', 'refund $5.00 by hand ONLY if it is not');
    expect(timedOut.auditNote).toBe(' (refund of $5.00 UNCONFIRMED)');

    fakeShopify(answer('Bad Gateway', 502));
    const badGateway = preproductionRefundOutcome(await refundFive(), '5.00');
    expect(badGateway.status).toBe('UNCONFIRMED');
    expect(badGateway.refundedAmount).toBeNull();
  });

  it('desk item change: a refusal from Shopify is FAILED, with the reason Shopify gave', async () => {
    fakeShopify(
      answer({
        data: { refundCreate: { refund: null, userErrors: [{ field: ['orderId'], message: 'Order does not exist' }] } },
      })
    );
    const out = preproductionRefundOutcome(await refundFive(), '5.00');
    expect(out.status).toBe('FAILED');
    expect(out.refundWarning).toContain('did NOT go through (reason: Order does not exist). Refund $5.00 by hand.');
    expect(out.auditNote).toBe(' (refund of $5.00 FAILED)');
  });

  it('desk item change: a refund that went through is REFUNDED, with no warning', async () => {
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
    expect(preproductionRefundOutcome(await refundFive(), '5.00')).toEqual({
      status: 'REFUNDED',
      refundedAmount: '5.00',
      refundWarning: null,
      auditNote: ' (refunded $5.00)',
    });
  });
});
