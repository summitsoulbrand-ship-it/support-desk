/**
 * The payment watcher for pricier self-service swaps.
 *
 * A PendingItemChange row means: the Shopify order was already edited to the
 * new variant (balance due = the discounted difference) and the customer got
 * Shopify's payment link. The ORIGINAL Printify order is untouched. This
 * sweep (worker, every few minutes) settles each row exactly one of three
 * ways:
 *
 *  PAID     -> apply the Printify swap (deterministic re-map against the LIVE
 *              copy). If production slipped in first: revert the edit +
 *              refund the charge + alert.
 *  EXPIRED  -> revert the Shopify edit; the original prints as ordered.
 *  CANCELLED-> order was cancelled/withdrawn meanwhile; just close the row.
 *
 * Rows that hit an unrecoverable error go FAILED with ONE loud alert (no
 * 3-minute alert spam) - a human finishes from the alert.
 */

import prisma from '@/lib/db';
import { logAction } from '@/lib/audit';
import { createShopifyClient } from '@/lib/shopify';
import { createPrintifyClient } from '@/lib/printify';
import type { PendingItemChange } from '@prisma/client';
import { resolvePrintifyOrders } from '@/lib/self-service/orders';
import { mapPrintifySwap, applyPrintifySwap } from '@/lib/self-service/item-swap';
import { notifySelfServiceFailure } from '@/lib/self-service/alerts';
import {
  sendSelfServiceSupportNotice,
  sendSelfServiceChangeConfirmation,
} from '@/lib/self-service/email';

async function setStatus(
  row: PendingItemChange,
  status: 'APPLIED' | 'EXPIRED_REVERTED' | 'CANCELLED' | 'FAILED',
  error?: string
) {
  await prisma.pendingItemChange
    .update({ where: { id: row.id }, data: { status, error: error ?? null } })
    .catch(() => undefined);
}

async function fail(row: PendingItemChange, step: string, error: string, humanAction: string) {
  await notifySelfServiceFailure({
    flow: 'item-change',
    orderName: row.shopifyOrderName,
    step,
    error,
    humanAction,
    customerEmail: row.customerEmail,
    detail: { pendingItemChangeId: row.id, shopifyOrderId: row.shopifyOrderId },
  });
  await setStatus(row, 'FAILED', `${step}: ${error}`);
}

/**
 * Revert the parked Shopify edit: remove the not-paid-for new line, restore
 * the original variant. No absorb needed - the original variant at catalog
 * price nets back to what the customer paid once their code re-applies.
 */
async function revertShopifyEdit(
  row: PendingItemChange,
  shopify: NonNullable<Awaited<ReturnType<typeof createShopifyClient>>>
): Promise<{ success: boolean; error?: string }> {
  const order = await shopify.getOrderById(row.shopifyOrderId);
  if (!order) return { success: false, error: 'order not found' };
  const newLine = order.lineItems.find(
    (li) => li.variantId === row.newVariantId && li.quantity === row.quantity
  );
  if (!newLine) {
    // Nothing to revert (already reverted by hand, or the edit never landed).
    return { success: true };
  }
  const res = await shopify.editOrder({
    orderId: row.shopifyOrderId,
    removeLineItemIds: [newLine.id],
    addItems: [{ variantId: row.oldVariantId, quantity: row.quantity }],
    notifyCustomer: false,
    staffNote: 'Self-service swap not paid in time - reverted to the original item.',
  });
  return { success: res.success, error: res.errors?.join('; ') };
}

export async function processPendingItemChanges(): Promise<{
  checked: number;
  applied: number;
  reverted: number;
  failed: number;
}> {
  const stats = { checked: 0, applied: 0, reverted: 0, failed: 0 };
  const rows = await prisma.pendingItemChange.findMany({
    where: { status: 'AWAITING_PAYMENT' },
    take: 20,
  });
  if (rows.length === 0) return stats;

  const shopify = await createShopifyClient();
  if (!shopify) return stats; // transient - retry next sweep

  for (const row of rows) {
    stats.checked++;
    try {
      const order = await shopify.getOrderById(row.shopifyOrderId);
      if (!order) continue; // transient - retry next sweep

      // Order cancelled/withdrawn while parked: the balance died with it.
      if (order.cancelledAt) {
        await setStatus(row, 'CANCELLED');
        continue;
      }

      const outstanding = parseFloat(order.totalOutstanding ?? 'NaN');
      const paid = Number.isFinite(outstanding) && outstanding <= 0.005;

      if (!paid) {
        if (new Date() < row.payBy) continue; // still waiting

        // ---- EXPIRED: revert, original prints as ordered ----
        const revert = await revertShopifyEdit(row, shopify);
        if (!revert.success) {
          stats.failed++;
          await fail(
            row,
            'Revert the unpaid swap edit',
            revert.error || 'edit revert failed',
            `Unpaid swap on ${row.shopifyOrderName}: the Shopify order still shows "${row.newVariantTitle}" with an open balance, but the ORIGINAL "${row.oldVariantTitle}" will print. Swap the Shopify line back by hand.`
          );
          continue;
        }
        await setStatus(row, 'EXPIRED_REVERTED');
        stats.reverted++;
        await sendSelfServiceChangeConfirmation({
          to: row.customerEmail,
          orderName: row.shopifyOrderName,
          heading: 'Your order stays as originally placed',
          changeSummary: `The payment for changing "${row.itemTitle}" to ${row.newVariantTitle} on order ${row.shopifyOrderName} didn't arrive before our print cutoff, so your order stays exactly as you first placed it (${row.oldVariantTitle}). Nothing was charged.`,
        }).catch(() => undefined);
        await logAction({
          threadId: null,
          userId: null,
          userName: 'System (payment watcher)',
          action: 'self_service_item_change_expired',
          summary: `Unpaid swap on ${row.shopifyOrderName} reverted - original ${row.oldVariantTitle} prints`,
          orderName: row.shopifyOrderName,
          metadata: { pendingItemChangeId: row.id },
        }).catch(() => undefined);
        continue;
      }

      // ---- PAID: apply the Printify swap against the LIVE copy ----
      const { live } = await resolvePrintifyOrders(order);
      const copy = live.length === 1 ? live[0] : null;
      const printify = await createPrintifyClient();
      if (!copy || !copy.order || !printify) {
        stats.failed++;
        await fail(
          row,
          'Apply the paid swap (resolve the live Printify copy)',
          !printify ? 'Printify client unavailable' : `expected 1 live copy, found ${live.length}`,
          `PAID swap on ${row.shopifyOrderName}: customer paid ${row.chargeAmount} for "${row.itemTitle}" ${row.oldVariantTitle} -> ${row.newVariantTitle}. Apply it in Printify by hand (Shopify side is already edited).`
        );
        continue;
      }

      const map = await mapPrintifySwap(printify, copy.order, {
        itemTitle: row.itemTitle,
        oldVariantTitle: row.oldVariantTitle,
        newVariantTitle: row.newVariantTitle,
        quantity: row.quantity,
      });
      if (!map) {
        stats.failed++;
        await fail(
          row,
          'Apply the paid swap (map the Printify line)',
          'could not deterministically match the line',
          `PAID swap on ${row.shopifyOrderName}: apply "${row.itemTitle}" ${row.oldVariantTitle} -> ${row.newVariantTitle} in Printify by hand (Shopify side is already edited and paid).`
        );
        continue;
      }

      const applied = await applyPrintifySwap(printify, {
        printifyOrderId: copy.id,
        origCopy: copy.order,
        shopifyOrderId: row.shopifyOrderId,
        shopifyOrderName: row.shopifyOrderName,
        map,
        itemTitle: row.itemTitle,
        newVariantTitle: row.newVariantTitle,
      });

      if (!applied.success) {
        if (applied.inProduction) {
          // Production slipped in between payment and apply: revert the edit
          // and give the money back - the original shirt is being printed.
          const revert = await revertShopifyEdit(row, shopify);
          const refund = await shopify.refundOrder(row.shopifyOrderId, {
            amount: row.chargeAmount,
            reason: 'Size change no longer possible - order entered production; refunding the paid difference',
            notify: true,
          });
          stats.failed++;
          await fail(
            row,
            'Paid swap arrived after production started',
            'Printify copy entered production before the swap could be applied',
            `Order ${row.shopifyOrderName} prints the ORIGINAL ${row.oldVariantTitle}. Charge refund ${refund.success ? 'DONE' : 'FAILED - refund ' + row.chargeAmount + ' by hand'}; Shopify revert ${revert.success ? 'done' : 'FAILED - swap the line back by hand'}. Consider offering the customer a replacement.`
          );
          await sendSelfServiceChangeConfirmation({
            to: row.customerEmail,
            orderName: row.shopifyOrderName,
            heading: "We couldn't make the change in time",
            changeSummary: `Your order ${row.shopifyOrderName} went to print just before your payment arrived, so it ships as originally placed (${row.oldVariantTitle}) and the ${row.chargeAmount} difference you paid is being refunded in full. Reply to this email and we will make it right if that doesn't work for you.`,
          }).catch(() => undefined);
          continue;
        }
        stats.failed++;
        await fail(
          row,
          'Apply the paid swap (Printify recreate)',
          applied.error || 'recreate failed',
          `PAID swap on ${row.shopifyOrderName}: apply "${row.itemTitle}" ${row.oldVariantTitle} -> ${row.newVariantTitle} in Printify by hand (recreate aborts safely; Shopify side is already edited and paid).`
        );
        continue;
      }

      await setStatus(row, 'APPLIED');
      stats.applied++;

      if (!applied.verified) {
        await notifySelfServiceFailure({
          flow: 'item-change',
          orderName: row.shopifyOrderName,
          step: 'Post-change verification (paid swap)',
          error: `Could not confirm "${row.newVariantTitle}" on Printify ${applied.newPrintifyOrderId}`,
          humanAction: `Open Printify ${applied.newPrintifyOrderId} and confirm one line is "${row.newVariantTitle}" for "${row.itemTitle}".`,
          customerEmail: row.customerEmail,
          detail: { pendingItemChangeId: row.id },
        });
      }

      await sendSelfServiceChangeConfirmation({
        to: row.customerEmail,
        orderName: row.shopifyOrderName,
        heading: 'Size/color updated',
        changeSummary: `Payment received - "${row.itemTitle}" on order ${row.shopifyOrderName} is now ${row.newVariantTitle}. Thanks!`,
      }).catch(() => undefined);

      await sendSelfServiceSupportNotice({
        orderName: row.shopifyOrderName,
        customerEmail: row.customerEmail,
        action: `Paid item change applied: ${row.oldVariantTitle} -> ${row.newVariantTitle} (+${row.chargeAmount})`,
        printifyCancelled: true,
        total: null,
        requestIp: null,
      }).catch(() => undefined);

      await logAction({
        threadId: null,
        userId: null,
        userName: 'System (payment watcher)',
        action: 'self_service_item_change_paid_applied',
        summary: `Paid swap applied on ${row.shopifyOrderName}: ${row.oldVariantTitle} -> ${row.newVariantTitle} (+${row.chargeAmount})${applied.verified ? ' (verified)' : ' (VERIFY FAILED)'}`,
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
