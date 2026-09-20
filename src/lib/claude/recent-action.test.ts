/**
 * What a reply draft is told about the refund inside a pre-production item
 * change. Get this wrong and the draft tells a customer their money is back
 * when the refund failed - measured 2026-09-19: 6 of 6 drafts did exactly that
 * from a bare negative balanceDelta. Customer money - keep green.
 */

import { describe, it, expect } from 'vitest';
import { preproductionRefundNote } from './recent-action';
import { ClaudeService } from './service';
import type { SuggestionContext } from './types';
import {
  preproductionRefundOutcome,
  preproductionRefundRecord,
} from '@/lib/self-service/refund-alert';
import { REFUND_UNCONFIRMED_WARNING } from '@/lib/shopify/idempotency';

const AT = '2026-09-17T17:08:00.000Z';

/** What the route saved BEFORE the refund result was kept. */
const LEGACY = {
  orderId: 'gid://shopify/Order/1',
  newPrintifyOrderId: 'pf_new',
  priceDifference: -15,
  balanceDelta: -15.9,
};

/** What the route saves now: the legacy fields, the order name, and the record. */
const saved = (refund: Parameters<typeof preproductionRefundOutcome>[0] | null) => ({
  ...LEGACY,
  orderName: '#99001',
  ...preproductionRefundRecord(
    refund ? preproductionRefundOutcome(refund, '15.90') : null,
    '15.90'
  ),
});
const REFUSED = { success: false, errors: ['No amount available to refund'] };
const TIMED_OUT = {
  success: false,
  outcomeUnknown: true,
  errors: ['The operation was aborted due to timeout', REFUND_UNCONFIRMED_WARNING],
};

const change = (data: Record<string, unknown>) => ({
  type: 'item_changed_preproduction',
  at: AT,
  data,
});
const ORDER = { orderNumber: '#99001' };
const ORDER_REFUNDED = { orderNumber: '#99001', refundedAmount: '15.90' };

/** The sentences that told a customer the money was back or on its way. */
function expectNoRefundClaimAllowed(note: string) {
  expect(note).toContain('NOT CONFIRMED');
  expect(note).toContain('No refund is known to exist');
  expect(note).toContain('The refund is NOT done');
  expect(note).toContain('never write that the difference has been refunded, credited, returned or processed');
  expect(note).toContain('never that it is being refunded or is on its way');
  expect(note).toContain('never give a bank timeline');
  // The change itself still gets confirmed - only the money is held back.
  expect(note).toContain('The item change itself IS done');
  // Off topic stays off topic. Measured: without this line a reply about
  // shipping started volunteering the refund (3 of 3 drafts, from 0 of 3).
  expect(note).toContain('Bring the refund up ONLY when the customer\'s message is about the price or the money');
  expect(note).toContain('leave the refund out of the reply entirely');
  // What the customer may be told instead, and what they are never told.
  expect(note).toContain('they will get the difference back on their original payment method');
  expect(note).toContain('you will confirm as soon as it has been issued');
  expect(note).toContain('Do not quote a dollar amount');
  expect(note).toContain('do not mention a failure, an error or a system problem');
}

describe('preproductionRefundNote - refund that did not go through', () => {
  it('FAILED: the draft may not say the money is back, coming, or give a bank timeline', () => {
    const note = preproductionRefundNote(change(saved(REFUSED)), ORDER, false) ?? '';
    expectNoRefundClaimAllowed(note);
    expect(note).toContain('about $15.90');
    expect(note).toContain('the Order Context above shows no refund on order #99001');
  });

  it('UNCONFIRMED reads the same to a customer: nothing proves the money moved', () => {
    const note = preproductionRefundNote(change(saved(TIMED_OUT)), ORDER, false) ?? '';
    expectNoRefundClaimAllowed(note);
    // Never "it failed" either - an unconfirmed refund may well have gone through.
    expect(note).not.toContain('FAILED');
    expect(note).not.toContain('did not go through');
  });

  it('a status this code does not know is treated as not confirmed, never as done', () => {
    const note =
      preproductionRefundNote(change({ ...saved(REFUSED), refundStatus: 'PENDING' }), ORDER, false) ?? '';
    expectNoRefundClaimAllowed(note);
  });

  it('never hands the agent-facing "refund by hand" wording to the draft', () => {
    for (const refund of [REFUSED, TIMED_OUT]) {
      const note = preproductionRefundNote(change(saved(refund)), ORDER, false) ?? '';
      expect(note).not.toContain('by hand');
      expect(note).not.toContain('Do not run the item change again');
    }
  });
});

describe('preproductionRefundNote - the live order wins over the saved snapshot', () => {
  it('someone refunded by hand since: go by the order, the old FAILED no longer gags the draft', () => {
    const note = preproductionRefundNote(change(saved(REFUSED)), ORDER_REFUNDED, false) ?? '';
    expect(note).toContain('the Order Context above now shows $15.90 refunded on order #99001');
    expect(note).toContain('That line is the live record');
    expect(note).not.toContain('NOT CONFIRMED');
    expect(note).not.toContain('never write');
  });

  it('an unconfirmed refund that did go through is found the same way', () => {
    const note = preproductionRefundNote(change(saved(TIMED_OUT)), ORDER_REFUNDED, false) ?? '';
    expect(note).toContain('now shows $15.90 refunded');
    expect(note).not.toContain('NOT CONFIRMED');
  });

  it('a refund on a DIFFERENT order proves nothing about this one', () => {
    const other = { orderNumber: '#99002', refundedAmount: '40.00' };
    const note = preproductionRefundNote(change(saved(REFUSED)), other, false) ?? '';
    expectNoRefundClaimAllowed(note);
    expect(note).not.toContain('$40.00');
    // And it does not claim to have looked at an order it cannot see.
    expect(note).toContain('nothing above shows a refund on order #99001');
    expect(note).not.toContain('the Order Context above shows no refund');
  });

  it('no order facts at all (Shopify hiccup): still no claim, and no invented "shows no refund"', () => {
    const note = preproductionRefundNote(change(saved(REFUSED)), undefined, false) ?? '';
    expectNoRefundClaimAllowed(note);
    expect(note).toContain('nothing above shows a refund on order #99001');
  });
});

describe('preproductionRefundNote - refund that went through', () => {
  it('REFUNDED: done, with the amount Shopify confirmed', () => {
    const note =
      preproductionRefundNote(
        change(saved({ success: true, refundedAmount: '15.89' })),
        ORDER,
        false
      ) ?? '';
    expect(note).toContain('DONE. $15.89 went back to the customer\'s original payment method');
    expect(note).toContain('confirmed by Shopify');
    expect(note).not.toContain('NOT CONFIRMED');
    expect(note).not.toContain('never write');
  });
});

describe('preproductionRefundNote - item changes saved before the result was kept', () => {
  it('cheaper item, no status, no refund on the order: not recorded is not refunded', () => {
    const note = preproductionRefundNote(change(LEGACY), ORDER, false) ?? '';
    expectNoRefundClaimAllowed(note);
    expect(note).toContain('was not recorded when the item was changed');
    expect(note).toContain('about $15.90');
    // No order name was saved back then.
    expect(note).toContain('shows no refund on the order');
  });

  it('cheaper item, no status, the order shows the refund: go by the order', () => {
    const note = preproductionRefundNote(change(LEGACY), ORDER_REFUNDED, false) ?? '';
    expect(note).toContain('now shows $15.90 refunded on the order');
    expect(note).not.toContain('NOT CONFIRMED');
  });
});

describe('preproductionRefundNote - says nothing when no money was owed', () => {
  it('a free size change, recorded: null status', () => {
    expect(preproductionRefundNote(change({ ...saved(null), balanceDelta: 0 }), ORDER, false)).toBeNull();
  });

  it('an absorbed upcharge', () => {
    expect(preproductionRefundNote(change({ ...LEGACY, priceDifference: 3, balanceDelta: 3 }), ORDER, false)).toBeNull();
  });

  it('a rounding-sized negative is not a refund', () => {
    expect(preproductionRefundNote(change({ ...LEGACY, balanceDelta: -0.0004 }), ORDER, false)).toBeNull();
  });

  it('any other action, even with a negative number in its details', () => {
    expect(
      preproductionRefundNote({ type: 'order_edited', at: AT, data: { balanceDelta: -15.9 } }, ORDER, false)
    ).toBeNull();
    expect(preproductionRefundNote({ type: 'order_refunded', at: AT }, ORDER, false)).toBeNull();
  });

  it('an item change with no details at all', () => {
    expect(preproductionRefundNote({ type: 'item_changed_preproduction', at: AT }, ORDER, false)).toBeNull();
  });
});

describe('preproductionRefundNote - operator is editing the draft', () => {
  it('holds back a refund claim, but the operator who has just refunded by hand wins', () => {
    const note = preproductionRefundNote(change(saved(REFUSED)), ORDER, true) ?? '';
    expect(note).toContain('was NOT confirmed when the item was changed');
    expect(note).toContain('Do not ADD a claim that it has been refunded or is on its way');
    expect(note).toContain("if the operator's instruction below says the refund has since been issued");
    expect(note).toContain('follow the operator');
    // The hard "never" block would fight the operator's own instruction.
    expect(note).not.toContain('never write');
  });
});

/** The note is only worth something if the draft prompt actually carries it. */
describe('Recent Agent Action block in the draft prompt', () => {
  const promptFor = (context: SuggestionContext) =>
    new ClaudeService({ apiKey: 'test-key' }).renderContextForReview(context);
  const base: SuggestionContext = {
    messages: [{ from: 'Dana', date: AT, subject: 'Change my order?', body: 'Will I get the difference back?' }],
    shopifyOrder: {
      orderNumber: '#99001',
      status: 'PAID',
      fulfillmentStatus: null,
      createdAt: AT,
      totalPrice: '32.90',
      currency: 'USD',
      lineItems: [{ title: 'Frog Wizard Tee - L', quantity: 1 }],
    },
  };

  it('a failed refund reaches the draft as NOT CONFIRMED, right under the details', () => {
    const prompt = promptFor({ ...base, recentAction: change(saved(REFUSED)) });
    const details = prompt.indexOf('- Details: {');
    const note = prompt.indexOf('- Refund of the price difference: NOT CONFIRMED');
    const closing = prompt.indexOf('write the reply as a confirmation of what HAS BEEN done');
    expect(details).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(details);
    // Before the "confirm what HAS BEEN done" line, which is what it qualifies.
    expect(closing).toBeGreaterThan(note);
    expect(prompt).toContain('"refundStatus":"FAILED"');
  });

  it('a refund on the live order turns the same saved FAILED into "go by the order"', () => {
    const prompt = promptFor({
      ...base,
      shopifyOrder: { ...base.shopifyOrder!, refundedAmount: '15.90' },
      recentAction: change(saved(REFUSED)),
    });
    expect(prompt).toContain('- Refund already issued: $15.90');
    expect(prompt).toContain('now shows $15.90 refunded on order #99001');
    expect(prompt).not.toContain('NOT CONFIRMED');
  });

  it('refinement mode gets the softer wording', () => {
    const prompt = promptFor({
      ...base,
      recentAction: change(saved(REFUSED)),
      refinement: { currentDraft: 'Hi Dana', instructions: 'say the refund was issued today' },
    });
    expect(prompt).toContain('follow the operator');
    expect(prompt).not.toContain('never write');
  });

  it('every other action keeps its prompt exactly as it was', () => {
    const recentAction = { type: 'shipping_address_updated', at: AT, data: { orderId: 'x' } };
    const prompt = promptFor({ ...base, recentAction });
    expect(prompt).toContain(
      '- Details: {"orderId":"x"}\nIf this action resolves what the customer asked for'
    );
    expect(prompt).not.toContain('Refund of the price difference');
  });
});
