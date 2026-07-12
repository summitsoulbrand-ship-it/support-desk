/**
 * Refund allocation across multiple tenders (split-tender orders).
 *
 * Shopify's refundCreate takes a `transactions` array - each entry a REFUND
 * against ONE parent SALE/CAPTURE. On a split-tender order (e.g. gift card +
 * credit card) each parent can only be refunded up to what it originally took,
 * minus anything already refunded against it. Refunding a single parent for
 * more than its own amount is rejected by Shopify. So a refund larger than the
 * biggest single tender has to be split across parents.
 *
 * This module is the pure math: given the order's transactions and a target
 * amount, decide how much REFUND to draw from each parent. Kept separate from
 * the network client so it can be unit-tested with no Shopify calls.
 */

export interface RefundTxn {
  id: string;
  kind: string;
  status: string;
  /** money amount as a string, e.g. "12.50" */
  amount: string;
  gateway: string;
  /** parent SALE/CAPTURE id for REFUND transactions */
  parentId?: string;
}

export interface RefundAllocation {
  /** parent SALE/CAPTURE transaction id to refund against */
  parentId: string;
  /** amount to refund against this parent, 2dp string */
  amount: string;
  gateway: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A refund transaction that reduces a parent's remaining refundable balance.
 * Anything not explicitly failed counts, so we never plan to over-refund a
 * tender that already has a pending refund against it.
 */
function isCountedRefund(t: RefundTxn): boolean {
  return t.kind === 'REFUND' && t.status !== 'FAILURE' && t.status !== 'ERROR';
}

/**
 * Split `targetAmount` across every successful SALE/CAPTURE transaction,
 * respecting each parent's own remaining refundable balance.
 *
 * The parents are drawn in list order (Shopify returns them oldest-first), so
 * a gift card that was applied first is drawn down before the card - matching
 * how a manual refund in the admin behaves. The total allocated is capped at
 * the sum of what every parent can still take, so the caller's order-level
 * available cap is preserved and never exceeded.
 *
 * Returns [] when there is nothing refundable (no parents, or target <= 0).
 */
export function allocateRefundTransactions(
  transactions: RefundTxn[],
  targetAmount: number
): RefundAllocation[] {
  if (!(targetAmount > 0)) return [];

  // Sum refunds already booked against each parent so we only plan the
  // remaining headroom per tender.
  const refundedByParent = new Map<string, number>();
  for (const t of transactions) {
    if (isCountedRefund(t) && t.parentId) {
      refundedByParent.set(
        t.parentId,
        (refundedByParent.get(t.parentId) ?? 0) + parseFloat(t.amount)
      );
    }
  }

  const parents = transactions.filter(
    (t) => (t.kind === 'SALE' || t.kind === 'CAPTURE') && t.status === 'SUCCESS'
  );

  const allocations: RefundAllocation[] = [];
  let remaining = r2(targetAmount);

  for (const parent of parents) {
    if (remaining <= 0) break;
    const alreadyRefunded = refundedByParent.get(parent.id) ?? 0;
    const headroom = r2(parseFloat(parent.amount) - alreadyRefunded);
    if (headroom <= 0) continue;

    const take = r2(Math.min(headroom, remaining));
    if (take <= 0) continue;

    allocations.push({
      parentId: parent.id,
      amount: take.toFixed(2),
      gateway: parent.gateway,
    });
    remaining = r2(remaining - take);
  }

  return allocations;
}
