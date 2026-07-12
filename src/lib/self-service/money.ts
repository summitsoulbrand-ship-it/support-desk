/**
 * Money math for self-service size/color swaps with a price difference.
 *
 * Policy (Pati, 2026-07-11): the customer pays / gets back the DISCOUNTED
 * difference - their discount code keeps applying to the new item, exactly as
 * checkout would have charged.
 *
 * The absorb value is the line discount applied to the swapped-in Shopify
 * line so the order's balance lands exactly on the intended charge (or the
 * intended overpayment for refunds). It targets the PRE-code price because
 * Shopify RE-APPLIES an order-level percentage code over edited lines - see
 * the operator flow's 2026-07-10 double-discount scar in
 * src/app/api/threads/[id]/orders/actions/route.ts (change_preproduction).
 * KEEP THE TWO IN SYNC.
 */

export interface SwapLine {
  /** Full catalog unit price */
  full: number;
  /** Unit price the customer actually paid (after discounts) */
  paid: number;
  quantity: number;
}

export type SwapMoneyKind = 'same' | 'refund' | 'charge';

export interface SwapMoney {
  kind: SwapMoneyKind;
  /** Absolute customer-facing amount (0 for 'same'), 2dp */
  amount: number;
  /** Line discount for the swapped-in line in the Shopify edit, 2dp, >= 0 */
  absorb: number;
  /** Derived order-level discount rate (0..0.9) */
  pctRate: number;
  /** What the customer had paid for the removed line (money basis), 2dp */
  removedPaid: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * @param allLines every line on the order (for the discount-rate derivation)
 * @param changed the line being swapped
 * @param newUnitFull catalog unit price of the new variant
 */
export function computeSwapMoney(
  allLines: SwapLine[],
  changed: SwapLine,
  newUnitFull: number
): SwapMoney {
  const origFull = allLines.reduce((s, l) => s + l.full * l.quantity, 0);
  const origPaid = allLines.reduce((s, l) => s + l.paid * l.quantity, 0);
  const pctRate =
    origFull > 0.01 ? Math.min(0.9, Math.max(0, 1 - origPaid / origFull)) : 0;
  const grossUp = (net: number) => (pctRate > 0.001 ? net / (1 - pctRate) : net);

  const removedPaid = r2(changed.paid * changed.quantity);
  const swappedInFull = r2(newUnitFull * changed.quantity);
  const productDiff = r2((newUnitFull - changed.full) * changed.quantity);
  // Discounted difference - what checkout would have charged/returned.
  const customerNet = r2(productDiff * (1 - pctRate));

  // The added line should net (after Shopify re-applies the code) to what the
  // old line netted, shifted by the customer's share of the difference.
  const targetNet = removedPaid + customerNet;
  const absorb = Math.max(0, r2(swappedInFull - grossUp(targetNet)));

  const kind: SwapMoneyKind =
    Math.abs(customerNet) < 0.005 ? 'same' : customerNet > 0 ? 'charge' : 'refund';

  return { kind, amount: Math.abs(customerNet), absorb, pctRate, removedPaid };
}
