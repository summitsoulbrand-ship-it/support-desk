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
 * cannot drift apart, and so does the one support-desk action that refunds as a
 * side effect (the pre-production item change, at the bottom). Pure text, no DB
 * and no network, so it is unit-tested. It is read by a non-technical person, in
 * Slack or on the desk screen: plain words, action spelled out.
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

/** How the refund inside a support-desk pre-production item change ended. */
export interface PreproductionRefundOutcome {
  status: 'REFUNDED' | 'FAILED' | 'UNCONFIRMED';
  /** What the screen reports as refunded, e.g. "5.00". Null unless it succeeded. */
  refundedAmount: string | null;
  /** What the agent must read, shown in red on the desk. Null when it succeeded. */
  refundWarning: string | null;
  /** Closes the audit line "Changed item before production on #1001". */
  auditNote: string;
}

/**
 * Support desk, pre-production item change to a CHEAPER item: the refund of the
 * difference is the LAST step, after Printify was remade and the Shopify order
 * edited. So a refund that does not report success cannot fail the action - the
 * change is already done - and until 2026-09-19 it was simply dropped: the agent
 * read "Order changed before production" and the audit log said "refunded".
 *
 * `owed` is the difference as the route computes it, e.g. "5.00" (the desk
 * writes every amount with a "$"). The agent sees the warning right under a
 * button that would run the whole change again, hence its last sentence.
 */
export function preproductionRefundOutcome(
  refund: RefundAttempt & { refundedAmount?: string },
  owed: string
): PreproductionRefundOutcome {
  if (refund.success) {
    return {
      status: 'REFUNDED',
      refundedAmount: refund.refundedAmount || owed,
      refundWarning: null,
      auditNote: ` (refunded $${owed})`,
    };
  }

  const amount = `$${owed}`;
  const opening = `The item change is done, but the refund of ${amount} to the customer`;
  const closing = 'Do not run the item change again.';

  if (refundIsUnconfirmed(refund)) {
    return {
      status: 'UNCONFIRMED',
      refundedAmount: null,
      refundWarning:
        `${opening} is ${lookFirst(`a refund of ${amount}`)}, ` +
        `and refund ${amount} by hand ONLY if it is not. ${closing}`,
      auditNote: ` (refund of ${amount} UNCONFIRMED)`,
    };
  }

  const reason = failureReason(refund);
  return {
    status: 'FAILED',
    refundedAmount: null,
    refundWarning:
      `${opening} did NOT go through${reason ? ` (reason: ${reason})` : ''}. ` +
      `Refund ${amount} by hand. ${closing}`,
    auditNote: ` (refund of ${amount} FAILED)`,
  };
}

/** What the item change writes on the thread about its refund (`lastActionData`). */
export interface PreproductionRefundRecord {
  /** How the refund of the difference ended. Null = the new item was not cheaper, nothing was owed. */
  refundStatus: PreproductionRefundOutcome['status'] | null;
  /** The difference the desk tried to refund, e.g. "5.00". Null when nothing was owed. */
  refundOwed: string | null;
  /** What Shopify confirmed as refunded. Null unless the refund went through. */
  refundedAmount: string | null;
}

/**
 * The same outcome, as the thread remembers it. The thread's last action feeds
 * every reply drafted afterwards ("Recent Agent Action" in the draft prompt),
 * and it used to keep only the negative price difference. Measured 2026-09-19
 * on the desk's own drafting model, made-up order, 3 drafts per case: all 6
 * drafts where the money came up told the customer the difference "has been
 * credited back" or "is being refunded, within a few business days" - with no
 * refund anywhere in the facts. The words the draft is given now live in
 * lib/claude/recent-action.ts.
 *
 * It is a snapshot of the moment of the change and is never updated: someone may
 * refund by hand an hour later. So it must never light a warning on the desk
 * screen - a "refund by hand" that outlives the by-hand refund is how a customer
 * gets paid twice (the red card is session-only for that reason). Whatever reads
 * it has to check the live order first.
 */
export function preproductionRefundRecord(
  outcome: PreproductionRefundOutcome | null,
  owed: string
): PreproductionRefundRecord {
  if (!outcome) return { refundStatus: null, refundOwed: null, refundedAmount: null };
  return {
    refundStatus: outcome.status,
    refundOwed: owed,
    refundedAmount: outcome.refundedAmount,
  };
}
