/**
 * What a reply draft is told about the MONEY inside a pre-production item change.
 *
 * When an agent swaps in a cheaper item before it prints, the desk refunds the
 * difference as the last step, and that refund can fail or come back unconfirmed
 * (see preproductionRefundOutcome in lib/self-service/refund-alert.ts). The
 * thread's last action then feeds every draft written afterwards, and all the
 * draft used to see was `"balanceDelta":-15.9` next to the instruction to write
 * the reply "as a confirmation of what HAS BEEN done".
 *
 * Measured 2026-09-19 on the desk's own drafting model with a made-up order, 3
 * drafts per case, no refund anywhere in the facts:
 *  - first reply written after the change: 2 of 3 said the difference "has been
 *    credited back to your original payment method", the third promised it
 *    "within a few business days";
 *  - customer writes back asking about the difference: 3 of 3 said "we are
 *    refunding it ... you should see it within a few business days";
 *  - customer writes back about something else: 0 of 3 brought the money up.
 * So the money only comes up when it is on topic, and then the draft always
 * said it was back or on its way.
 *
 * Same cases with the wording below, a FAILED or UNCONFIRMED refund saved: 9
 * of 9 on-topic drafts said "you will get the difference back ... I am taking
 * care of that refund myself and will confirm as soon as it has been issued",
 * and 3 of 3 said "$15.90 was refunded" once the refund was saved as REFUNDED.
 * A first version without the "Bring the refund up ONLY when" sentence made the
 * off-topic reply start volunteering the refund (3 of 3, from 0 of 3); with it,
 * 0 of 3 again. Small samples - they show direction, not a rate.
 *
 * Two rules shape the wording below:
 *  1. The saved status is a SNAPSHOT of the moment of the change. Someone may
 *     have refunded by hand since, so the live order (the Order Context's
 *     "Refund already issued" line) always wins over it.
 *  2. This text goes to the drafting model and nowhere else. It must never
 *     become a warning on the desk screen: a "refund by hand" that outlives the
 *     by-hand refund is how a customer gets paid twice.
 *
 * Pure text, no DB and no network, so it is unit-tested.
 */

import type { SuggestionContext } from './types';

const ITEM_CHANGE = 'item_changed_preproduction';

type RecentAction = NonNullable<SuggestionContext['recentAction']>;
type OrderFacts = Pick<
  NonNullable<SuggestionContext['shopifyOrder']>,
  'orderNumber' | 'refundedAmount'
>;

/**
 * The lines added under "Recent Agent Action" for an item change that owed the
 * customer money, or null when there is nothing to say (another action, or the
 * new item was not cheaper).
 *
 * `order` is the ONE order the Order Context describes. `refinement` = the
 * operator is editing an existing draft: they may have just refunded by hand,
 * and the order facts are cached in that mode, so their word has to win.
 */
export function preproductionRefundNote(
  action: RecentAction,
  order: OrderFacts | undefined,
  refinement: boolean
): string | null {
  if (action.type !== ITEM_CHANGE) return null;
  const data = action.data ?? {};

  // Item changes saved before the refund result was kept carry no status at
  // all. For those a negative balanceDelta is the only sign money was owed.
  const recorded = 'refundStatus' in data;
  const status = recorded ? data.refundStatus : undefined;
  const delta = typeof data.balanceDelta === 'number' ? data.balanceDelta : 0;
  if (recorded ? status === null : !(delta < -0.001)) return null;

  const owed =
    typeof data.refundOwed === 'string' && data.refundOwed
      ? data.refundOwed
      : Math.abs(delta).toFixed(2);
  const orderName =
    typeof data.orderName === 'string' && data.orderName ? data.orderName : null;
  const where = orderName ? `order ${orderName}` : 'the order';
  const head = '- Refund of the price difference: ';

  if (status === 'REFUNDED') {
    const amount =
      typeof data.refundedAmount === 'string' && data.refundedAmount
        ? data.refundedAmount
        : owed;
    return (
      `${head}DONE. $${amount} went back to the customer's original payment method when the item ` +
      'was changed (confirmed by Shopify). If the reply mentions the price difference, say it as ' +
      'done and name the amount; it can take 3-5 business days to show at their bank.\n'
    );
  }

  // FAILED, UNCONFIRMED, not recorded, or a status this code does not know:
  // all the same to a customer - nothing proves the money moved.
  const then = recorded
    ? 'was not confirmed when the item was changed'
    : 'was not recorded when the item was changed';

  // The Order Context describes one order (the most recent). Its refund line
  // only counts when that IS the changed order. Older records carry no order
  // name; there the most recent order is the only one the draft can see.
  const sameOrder = !!order && (!orderName || order.orderNumber === orderName);
  const liveRefund = sameOrder && order?.refundedAmount ? order.refundedAmount : null;
  if (liveRefund) {
    return (
      `${head}the automatic refund ${then}, but the Order Context above now shows ` +
      `$${liveRefund} refunded on ${where}. That line is the live record - go by it, and state ` +
      'nothing about the refund beyond what it shows.\n'
    );
  }

  const noLiveRefund = sameOrder
    ? `the Order Context above shows no refund on ${where}`
    : `nothing above shows a refund on ${where}`;

  if (refinement) {
    return (
      `${head}${then.replace('was not', 'was NOT')} (about $${owed} owed to the customer), and ` +
      `${noLiveRefund}. Do not ADD a claim that it has been refunded or is on its way. The one ` +
      'exception: if the operator\'s instruction below says the refund has since been issued, the ' +
      'operator has looked at the order - follow the operator.\n'
    );
  }

  return (
    `${head}NOT CONFIRMED. The new item is cheaper, so money is owed back to the customer ` +
    `(about $${owed}), but the automatic refund ${then}, and ${noLiveRefund}. No refund is known to exist.\n` +
    '  The item change itself IS done - confirm that part as done. The refund is NOT done: never ' +
    'write that the difference has been refunded, credited, returned or processed, never that it ' +
    'is being refunded or is on its way, and never give a bank timeline ("within a few business ' +
    'days"). Each of those tells the customer that money is coming which nobody has sent.\n' +
    '  Bring the refund up ONLY when the customer\'s message is about the price or the money, or ' +
    'when this reply is the one telling them the item was changed. If they wrote about anything ' +
    'else (shipping, sizing, an address), leave the refund out of the reply entirely. When it does ' +
    'come up, say only this: they will get the difference back on their original payment method, ' +
    'you are taking care of that refund yourself, and you will confirm as soon as it has been ' +
    'issued. Do not quote a dollar amount for it, and do not mention a failure, an error or a ' +
    'system problem.\n'
  );
}
