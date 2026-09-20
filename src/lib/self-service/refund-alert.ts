/**
 * What to tell a person when an automatic refund did not come back as done.
 *
 * Two very different cases hide behind `success: false` (see
 * ShopifyClient.refundOrder):
 *
 *  REFUSED      Shopify, or our own checks before the call, said no. No money
 *               moved. A person refunds by hand, and the reason says why.
 *  UNCONFIRMED  (`outcomeUnknown`) The request went out and no answer came back
 *               (timeout, dropped connection, 5xx), or Shopify says the same
 *               refund is still in progress. The money MAY already be with the
 *               customer. "Refund by hand" here is how a customer gets paid
 *               twice, so the instruction is: look at the order first.
 *
 * Every self-service refund alert takes its wording from here so the flows
 * cannot drift apart. Pure text, no DB and no network, so it is unit-tested.
 * It is read by a non-technical person in Slack: plain words, action spelled out.
 */

import { REFUND_UNCONFIRMED_WARNING } from '@/lib/shopify/idempotency';

/** The part of refundOrder's answer the wording depends on. */
export interface RefundAttempt {
  success: boolean;
  outcomeUnknown?: boolean;
  errors?: string[];
}

/** A raw Shopify error body can run to pages; the alert has to stay readable. */
const MAX_REASON_LENGTH = 300;

/**
 * Could the money have moved even though the refund did not report success?
 *
 * The flag is the signal. The warning sentence is checked too: the two always
 * travel together, and calling an unconfirmed refund "failed" is the expensive
 * mistake, so either one is enough.
 */
export function refundIsUnconfirmed(refund: RefundAttempt): boolean {
  if (refund.success) return false;
  return (
    refund.outcomeUnknown === true ||
    (refund.errors ?? []).some((e) => e.includes(REFUND_UNCONFIRMED_WARNING))
  );
}

/**
 * The look-first instruction. `what` names the refund the way the person will
 * see it on the order, e.g. "a refund of 5.00". No closing period - each alert
 * finishes the sentence its own way.
 */
function lookFirst(what: string): string {
  return (
    'UNCONFIRMED - Shopify did not confirm it, so it may or may not have gone through. ' +
    `BEFORE refunding by hand, open the order in Shopify and check whether ${what} is already there`
  );
}

function failureReason(refund: RefundAttempt): string {
  const reason = (refund.errors ?? [])
    .map((e) => e.trim())
    .filter(Boolean)
    .join('; ');
  return reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH)}...` : reason;
}

/**
 * Payment watcher, production slipped in: the words that follow "Charge refund ".
 * `amount` is the charge as stored on the row, e.g. "5.00".
 */
export function chargeRefundStatus(refund: RefundAttempt, amount: string): string {
  if (refund.success) return 'DONE';
  if (refundIsUnconfirmed(refund)) {
    return `${lookFirst(`a refund of ${amount}`)}, and refund ${amount} by hand ONLY if it is not`;
  }
  const reason = failureReason(refund);
  return `FAILED - refund ${amount} by hand${reason ? ` (reason: ${reason})` : ''}`;
}

/**
 * Item change, net cheaper: the "Do now" sentence for a refund that did not
 * report success. `amountLabel` carries the currency, e.g. "5.00 USD". The
 * reason is not repeated here - that alert already shows it on its Error line.
 */
export function refundByHandAction(refund: RefundAttempt, amountLabel: string): string {
  if (refundIsUnconfirmed(refund)) {
    return (
      `The refund of ${amountLabel} is ${lookFirst(`a refund of ${amountLabel}`)}, ` +
      `and refund ${amountLabel} by hand ONLY if it is not.`
    );
  }
  return `Refund ${amountLabel} by hand.`;
}

/** EU withdrawal: the "Do now" text for a full refund that did not report success. */
export function withdrawalRefundAction(refund: RefundAttempt): string {
  if (refundIsUnconfirmed(refund)) {
    return (
      `EU withdrawal was requested but the refund is ${lookFirst('the full refund')}. ` +
      'If it is NOT there and the customer does not retry, issue the full refund by hand - the 14-day right stands regardless.'
    );
  }
  return 'EU withdrawal was requested but the refund did NOT go through. If the customer does not retry, issue the full refund by hand - the 14-day right stands regardless.';
}
