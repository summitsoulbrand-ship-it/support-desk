/**
 * The payment watcher for pricier self-service swaps.
 *
 * A PendingItemChange row means: the Shopify order was edited to the new
 * variant (balance due = the exact Shopify-calculated difference) and the
 * customer got Shopify's payment link. The ORIGINAL Printify order is
 * untouched. This sweep (worker, every few minutes) settles each row exactly
 * one of these ways:
 *
 *  PAID     -> apply the Printify swap (deterministic re-map against the LIVE
 *              copy). Production slipped in first: revert + refund + alert.
 *  EXPIRED  -> revert the Shopify edit; the original prints as ordered.
 *  CANCELLED-> order cancelled/withdrawn meanwhile, or the edit never
 *              committed (crash) - close the row.
 *  FAILED   -> unrecoverable; ONE loud alert, a human finishes.
 *
 * Correctness rules learned in review:
 *  - Every terminal transition is a COMPARE-AND-SWAP from AWAITING_PAYMENT
 *    (updateMany + count check) so a cancel landing mid-sweep can never be
 *    overwritten, and a lost status write can never double-apply.
 *  - The ADDED line is identified from preEditLineIds (ids before the edit),
 *    never guessed by variant+quantity - a duplicate-variant order would
 *    otherwise let the revert delete the customer's PAID sibling line.
 *  - "Paid" = outstanding cleared AND the added line still present; a
 *    reverted edit also clears the balance and must not read as paid.
 */

import prisma from '@/lib/db';
import { logAction } from '@/lib/audit';
import { createShopifyClient } from '@/lib/shopify';
import { createPrintifyClient } from '@/lib/printify';
import { labelTokens } from '@/lib/printify/relink';
import type { PendingItemChange } from '@prisma/client';
import type { ShopifyOrder } from '@/lib/shopify/types';
import { resolvePrintifyOrders } from '@/lib/self-service/orders';
import {
  mapPrintifySwap,
  applyPrintifySwap,
  toSwapInputs,
  titlesMatch,
  type BatchLineChange,
} from '@/lib/self-service/item-swap';
import { notifySelfServiceFailure } from '@/lib/self-service/alerts';
import { selfServiceMonitor } from '@/lib/self-service/monitor';
import {
  sendSelfServiceSupportNotice,
  sendSelfServiceChangeConfirmation,
} from '@/lib/self-service/email';

type Terminal = 'APPLIED' | 'EXPIRED_REVERTED' | 'CANCELLED' | 'FAILED';

/** CAS from AWAITING_PAYMENT. False = someone else already settled the row. */
async function claim(
  row: PendingItemChange,
  status: Terminal,
  error?: string
): Promise<boolean> {
  try {
    const res = await prisma.pendingItemChange.updateMany({
      where: { id: row.id, status: 'AWAITING_PAYMENT' },
      data: { status, error: error ?? null },
    });
    return res.count === 1;
  } catch {
    return false;
  }
}

/** Claim FAILED + alert a human - but only if we actually won the claim. */
async function fail(
  row: PendingItemChange,
  step: string,
  error: string,
  humanAction: string
): Promise<void> {
  if (!(await claim(row, 'FAILED', `${step}: ${error}`))) return;
  await notifySelfServiceFailure({
    flow: 'item-change',
    orderName: row.shopifyOrderName,
    step,
    error,
    humanAction,
    customerEmail: row.customerEmail,
    detail: { pendingItemChangeId: row.id, shopifyOrderId: row.shopifyOrderId },
  });
}

/** The batch of line changes this row parked (JSON `changes`, or the flat legacy columns). */
function rowChanges(row: PendingItemChange): BatchLineChange[] {
  if (row.changes) {
    try {
      const arr = row.changes as unknown as BatchLineChange[];
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch {
      // fall through to legacy
    }
  }
  return [
    {
      lineItemId: row.lineItemId,
      itemTitle: row.itemTitle,
      oldVariantId: row.oldVariantId,
      oldVariantTitle: row.oldVariantTitle,
      oldUnitFull: row.oldUnitFull,
      removedPaid: row.removedPaid,
      newVariantId: row.newVariantId,
      newVariantTitle: row.newVariantTitle,
      quantity: row.quantity,
      absorb: '0',
    },
  ];
}

/** One-line human summary of the batch. */
function batchSummary(changes: BatchLineChange[]): string {
  return changes
    .map((c) => `${c.itemTitle}: ${c.oldVariantTitle} -> ${c.newVariantTitle}`)
    .join('; ');
}

/**
 * The lines the parked edit ADDED, one per change: each matches that change's
 * new variant AND is not a pre-edit line. Distinct per change (consume matched
 * lines) so a batch that added two of the same variant maps to two lines.
 * Returns null if ANY change's added line can't be found (fail closed).
 */
function findAddedLines(
  order: ShopifyOrder,
  row: PendingItemChange,
  changes: BatchLineChange[]
): { change: BatchLineChange; lineId: string }[] | null {
  let preIds: string[] = [];
  try {
    preIds = row.preEditLineIds ? (JSON.parse(row.preEditLineIds) as string[]) : [];
  } catch {
    preIds = [];
  }
  if (preIds.length === 0) return null; // legacy/unknown - fail closed
  const available = order.lineItems.filter((li) => !preIds.includes(li.id));
  const claimed = new Set<string>();
  const out: { change: BatchLineChange; lineId: string }[] = [];
  for (const ch of changes) {
    const hit = available.find(
      (li) => li.variantId === ch.newVariantId && !claimed.has(li.id)
    );
    if (!hit) return null;
    claimed.add(hit.id);
    out.push({ change: ch, lineId: hit.id });
  }
  return out;
}

/** Remove every added line (by exact id) and restore every original variant. */
async function revertShopifyEdit(
  row: PendingItemChange,
  shopify: NonNullable<Awaited<ReturnType<typeof createShopifyClient>>>,
  added: { change: BatchLineChange; lineId: string }[]
): Promise<{ success: boolean; error?: string }> {
  const res = await shopify.editOrder({
    orderId: row.shopifyOrderId,
    removeLineItemIds: added.map((a) => a.lineId),
    addItems: added.map((a) => ({
      variantId: a.change.oldVariantId,
      quantity: a.change.quantity,
    })),
    notifyCustomer: false,
    staffNote: 'Self-service change not paid in time - reverted to the original items.',
  });
  return { success: res.success, error: res.errors?.join('; ') };
}

/** Rows stuck past any plausible resolution get one alert instead of silence. */
const STUCK_AFTER_MS = 48 * 60 * 60 * 1000;
const REVERT_GRACE_MS = 10 * 60 * 1000;
/** A rowed edit that never shows up on the order after this long never committed. */
const EDIT_ABSENT_CLOSE_MS = 15 * 60 * 1000;

export async function processPendingItemChanges(): Promise<{
  checked: number;
  applied: number;
  reverted: number;
  failed: number;
}> {
  const stats = { checked: 0, applied: 0, reverted: 0, failed: 0 };
  const rows = await prisma.pendingItemChange.findMany({
    where: { status: 'AWAITING_PAYMENT' },
    orderBy: { payBy: 'asc' },
    take: 20,
  });
  if (rows.length === 0) return stats;

  const shopify = await createShopifyClient();
  if (!shopify) return stats; // transient - retry next sweep

  for (const row of rows) {
    stats.checked++;
    try {
      const order = await shopify.getOrderById(row.shopifyOrderId);
      if (!order) {
        // Persistent nulls must not silently starve the queue forever.
        if (Date.now() - row.payBy.getTime() > STUCK_AFTER_MS) {
          stats.failed++;
          await fail(
            row,
            'Load the Shopify order',
            'order unreadable for 48h+ past the deadline',
            `Parked swap on ${row.shopifyOrderName} is stuck: check the order by hand (charge ${row.chargeAmount}, ${row.oldVariantTitle} -> ${row.newVariantTitle}).`
          );
        }
        continue;
      }

      // Order cancelled/withdrawn while parked: the balance died with it.
      if (order.cancelledAt) {
        await claim(row, 'CANCELLED');
        continue;
      }

      const changes = rowChanges(row);
      const summary = batchSummary(changes);
      const addedLines = findAddedLines(order, row, changes);
      if (!addedLines) {
        // The edited line is not on the order: the edit never committed
        // (crash between row-create and edit) or someone reverted by hand.
        // Either way there is nothing to apply or revert - close the row
        // once the edit has had ample time to appear.
        if (Date.now() - row.createdAt.getTime() > EDIT_ABSENT_CLOSE_MS) {
          await claim(
            row,
            'CANCELLED',
            'edit absent on the order (never committed, or reverted by hand) - closed without side effects'
          );
        }
        continue;
      }

      const outstanding = parseFloat(order.totalOutstanding ?? 'NaN');
      const paid = Number.isFinite(outstanding) && outstanding <= 0.005;

      if (!paid) {
        // Grace past the deadline (still >30 min before the cutoff): a
        // customer mid-checkout at the buzzer must not collide with the revert.
        if (Date.now() < row.payBy.getTime() + REVERT_GRACE_MS) continue;

        // Payment can land between the check above and this revert - re-read
        // once more right before touching anything.
        const fresh = await shopify.getOrderById(row.shopifyOrderId);
        const freshOutstanding = parseFloat(fresh?.totalOutstanding ?? 'NaN');
        if (fresh && Number.isFinite(freshOutstanding) && freshOutstanding <= 0.005) {
          continue; // paid at the buzzer - the paid path applies it next sweep
        }

        // ---- EXPIRED: revert, originals print as ordered ----
        const revert = await revertShopifyEdit(row, shopify, addedLines);
        if (!revert.success) {
          stats.failed++;
          await fail(
            row,
            'Revert the unpaid change edit',
            revert.error || 'edit revert failed',
            `Unpaid change on ${row.shopifyOrderName}: the Shopify order still shows the new choice(s) with an open balance, but the ORIGINALS will print. Swap the Shopify line(s) back by hand: ${summary}.`
          );
          continue;
        }
        if (!(await claim(row, 'EXPIRED_REVERTED'))) continue; // settled elsewhere
        stats.reverted++;
        await selfServiceMonitor({
          text: `:leftwards_arrow_with_hook: ${row.shopifyOrderName} - Change not paid in time, reverted to originals: ${summary} | ${row.customerEmail}`,
          shopifyOrderId: row.shopifyOrderId,
          printifyOrderId: row.printifyOrderId,
        });
        await sendSelfServiceChangeConfirmation({
          to: row.customerEmail,
          orderName: row.shopifyOrderName,
          heading: 'Your order stays as originally placed',
          changeSummary: `The payment for your change on order ${row.shopifyOrderName} didn't arrive within the payment window, so your order stays exactly as you first placed it. Nothing was charged.`,
        }).catch(() => undefined);
        await logAction({
          threadId: null,
          userId: null,
          userName: 'System (payment watcher)',
          action: 'self_service_item_change_expired',
          summary: `Unpaid change on ${row.shopifyOrderName} reverted - originals print (${summary})`,
          orderName: row.shopifyOrderName,
          metadata: { pendingItemChangeId: row.id },
        }).catch(() => undefined);
        continue;
      }

      // ---- PAID: apply the Printify change(s) against the LIVE copy ----
      const { live } = await resolvePrintifyOrders(order);
      const copy = live.length === 1 ? live[0] : null;
      const printify = await createPrintifyClient();
      if (!copy || !copy.order || !printify) {
        stats.failed++;
        await fail(
          row,
          'Apply the paid change (resolve the live Printify copy)',
          !printify ? 'Printify client unavailable' : `expected 1 live copy, found ${live.length}`,
          `PAID change on ${row.shopifyOrderName}: customer paid ${row.chargeAmount} for: ${summary}. Apply it in Printify by hand (Shopify side is already edited).`
        );
        continue;
      }

      const map = await mapPrintifySwap(printify, copy.order, toSwapInputs(changes));
      if (!map) {
        // Self-heal: a lost APPLIED status write (or a crash after the
        // recreate) leaves the live copy ALREADY showing the new choices -
        // that is success, not a failure to page a human about. Every change
        // must be present on the right design.
        let alreadyApplied = false;
        try {
          const createdLines = [...copy.order.line_items];
          alreadyApplied = true;
          for (const ch of changes) {
            const want = labelTokens(ch.newVariantTitle);
            let hitIdx = -1;
            for (let i = 0; i < createdLines.length; i++) {
              const li = createdLines[i];
              const prod = await printify.getProduct(li.product_id);
              const v = prod?.variants.find((pv) => pv.id === li.variant_id);
              if (!v || labelTokens(v.title) !== want) continue;
              if (titlesMatch(ch.itemTitle, li.metadata?.title || prod?.title || '')) {
                hitIdx = i;
                break;
              }
            }
            if (hitIdx < 0) {
              alreadyApplied = false;
              break;
            }
            createdLines.splice(hitIdx, 1);
          }
        } catch {
          alreadyApplied = false;
        }
        if (alreadyApplied) {
          if (await claim(row, 'APPLIED', 'self-healed: live copy already carries the new choices')) {
            stats.applied++;
            await sendSelfServiceChangeConfirmation({
              to: row.customerEmail,
              orderName: row.shopifyOrderName,
              heading: 'Your order was updated',
              changeSummary: `Payment received - your order ${row.shopifyOrderName} is now updated (${summary}). Thanks!`,
            }).catch(() => undefined);
          }
          continue;
        }
        stats.failed++;
        await fail(
          row,
          'Apply the paid change (map the Printify lines)',
          'could not deterministically match the lines',
          `PAID change on ${row.shopifyOrderName}: apply in Printify by hand (Shopify side is already edited and paid): ${summary}.`
        );
        continue;
      }

      const applied = await applyPrintifySwap(printify, {
        printifyOrderId: copy.id,
        origCopy: copy.order,
        shopifyOrderId: row.shopifyOrderId,
        shopifyOrderName: row.shopifyOrderName,
        map,
      });

      if (!applied.success) {
        // A cancel racing this apply makes the recreate fail on the
        // cancelled-original guard - that is the cancel winning, not an error.
        const recheck = await shopify.getOrderById(row.shopifyOrderId);
        if (recheck?.cancelledAt) {
          await claim(row, 'CANCELLED');
          continue;
        }
        if (applied.inProduction) {
          // Production slipped in between payment and apply: revert the edit
          // and give the money back - the originals are being printed.
          const revert = await revertShopifyEdit(row, shopify, addedLines);
          const refund = await shopify.refundOrder(row.shopifyOrderId, {
            amount: row.chargeAmount,
            reason:
              'Change no longer possible - order entered production; refunding the paid difference',
            notify: true,
          });
          stats.failed++;
          await fail(
            row,
            'Paid change arrived after production started',
            'Printify copy entered production before the change could be applied',
            `Order ${row.shopifyOrderName} prints the ORIGINALS. Charge refund ${refund.success ? 'DONE' : 'FAILED - refund ' + row.chargeAmount + ' by hand'}; Shopify revert ${revert.success ? 'done' : 'FAILED - swap the line(s) back by hand'}. Intended: ${summary}. Consider offering the customer a replacement.`
          );
          await sendSelfServiceChangeConfirmation({
            to: row.customerEmail,
            orderName: row.shopifyOrderName,
            heading: "We couldn't make the change in time",
            changeSummary: `Your order ${row.shopifyOrderName} went to print just before your payment arrived, so it ships as originally placed and the ${row.chargeAmount} difference you paid is being refunded in full. Reply to this email and we will make it right if that doesn't work for you.`,
          }).catch(() => undefined);
          continue;
        }
        stats.failed++;
        await fail(
          row,
          'Apply the paid change (Printify recreate)',
          applied.error || 'recreate failed',
          `PAID change on ${row.shopifyOrderName}: apply in Printify by hand (recreate aborts safely; Shopify side is already edited and paid): ${summary}.`
        );
        continue;
      }

      // Claim BEFORE the emails: if the row was cancelled mid-apply, the
      // cancel flow owns the customer communication.
      if (!(await claim(row, 'APPLIED'))) continue;
      stats.applied++;

      if (!applied.verified) {
        await notifySelfServiceFailure({
          flow: 'item-change',
          orderName: row.shopifyOrderName,
          step: 'Post-change verification (paid change)',
          error: `Could not confirm the new choices on Printify ${applied.newPrintifyOrderId}`,
          humanAction: `Open Printify ${applied.newPrintifyOrderId} and confirm: ${summary}.`,
          customerEmail: row.customerEmail,
          detail: { pendingItemChangeId: row.id },
        });
      }

      await sendSelfServiceChangeConfirmation({
        to: row.customerEmail,
        orderName: row.shopifyOrderName,
        heading: 'Your order was updated',
        changeSummary: `Payment received - your order ${row.shopifyOrderName} is now updated (${summary}). Thanks!`,
      }).catch(() => undefined);

      await sendSelfServiceSupportNotice({
        orderName: row.shopifyOrderName,
        customerEmail: row.customerEmail,
        action: `Paid item change applied: ${summary} (+${row.chargeAmount})`,
        printifyCancelled: true,
        total: null,
        requestIp: null,
        shopifyOrderId: row.shopifyOrderId,
        printifyOrderId: applied.newPrintifyOrderId,
      }).catch(() => undefined);

      await logAction({
        threadId: null,
        userId: null,
        userName: 'System (payment watcher)',
        action: 'self_service_item_change_paid_applied',
        summary: `Paid change applied on ${row.shopifyOrderName}: ${summary} (+${row.chargeAmount})${applied.verified ? ' (verified)' : ' (VERIFY FAILED)'}`,
        orderName: row.shopifyOrderName,
        amountCents: Math.round(parseFloat(row.chargeAmount) * 100),
        metadata: { pendingItemChangeId: row.id, newPrintifyOrderId: applied.newPrintifyOrderId },
      }).catch(() => undefined);
    } catch (err) {
      // Transient row error: log and let the next sweep retry.
      console.error(
        `[payment-watch] row ${row.id} (${row.shopifyOrderName}) error:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return stats;
}
