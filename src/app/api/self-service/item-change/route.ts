/**
 * POST /api/self-service/item-change  { token, lineItemId, newVariantId }
 *
 * Customer swaps a line item's size/color BEFORE the order goes to print.
 * Same product only; three money cases (structure adopted from the mastermind
 * portal brief, policy set by Pati 2026-07-11):
 *
 *  - SAME price: apply immediately (Printify cancel+recreate, then the
 *    Shopify edit). No money moves.
 *  - CHEAPER: apply immediately + automatically refund the DISCOUNTED
 *    difference to the original payment method.
 *  - PRICIER: commit the Shopify edit (balance due = discounted difference),
 *    send Shopify's own payment link, and park a PendingItemChange. Printify
 *    stays UNTOUCHED until the worker sees the balance paid; unpaid by the
 *    deadline -> the edit auto-reverts and the original prints as ordered.
 *    (Printify has no real hold - the nightly ~11pm PT sweep auto-submits
 *    API orders too, verified 2026-07-11 - so holding nothing is the only
 *    honest design.)
 *
 * Everything is validated server-side BEFORE anything is committed, and the
 * Printify mapping is deterministic (see item-swap.ts). Gated by the launch
 * gate.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import { logAction } from '@/lib/audit';
import { createShopifyClient } from '@/lib/shopify';
import { createPrintifyClient } from '@/lib/printify';
import {
  getValidToken,
  consumeToken,
  releaseToken,
} from '@/lib/self-service/tokens';
import { manageFlowAllowed } from '@/lib/self-service/gate';
import {
  loadOrderStateForToken,
  reasonMessage,
  hasActiveReroute,
} from '@/lib/self-service/orders';
import { mapPrintifySwap, applyPrintifySwap } from '@/lib/self-service/item-swap';
import { computeSwapMoney } from '@/lib/self-service/money';
import { productionCutoff } from '@/lib/self-service/cutoff';
import { notifySelfServiceFailure } from '@/lib/self-service/alerts';
import {
  sendSelfServiceSupportNotice,
  sendSelfServiceChangeConfirmation,
} from '@/lib/self-service/email';

const bodySchema = z.object({
  token: z.string().min(1),
  lineItemId: z.string().min(1),
  newVariantId: z.string().min(1),
});

// The pricier flow needs breathing room before the production cutoff: the
// payment window ends 45 min before the sweep, and we refuse to start one
// with less than 15 usable minutes.
const PAY_WINDOW_MAX_MS = 6 * 60 * 60 * 1000;
const PAY_BUFFER_BEFORE_CUTOFF_MS = 45 * 60 * 1000;
const PAY_WINDOW_MIN_MS = 15 * 60 * 1000;

export async function POST(request: NextRequest) {
  if (!manageFlowAllowed(request)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const token = await getValidToken(body.token);
  if (!token || token.purpose !== 'MANAGE') {
    return NextResponse.json(
      { error: 'This link is invalid or has expired. Please request a new one.' },
      { status: 400 }
    );
  }

  // LIVE re-check at the moment of action.
  const state = await loadOrderStateForToken(token);
  if (!state) {
    return NextResponse.json(
      { error: 'We could not load this order. Contact support@summitsoul.shop.' },
      { status: 404 }
    );
  }
  if (!state.eligibility.eligible) {
    return NextResponse.json(
      { error: reasonMessage(state.eligibility.reason), reason: state.eligibility.reason },
      { status: 409 }
    );
  }
  if (state.printifyOrders.length === 0) {
    // Brand new - the print partner hasn't picked the order up yet.
    return NextResponse.json(
      {
        error:
          'Your order is still being set up on our side. Please try again in a few minutes - or email support@summitsoul.shop and we will swap it for you.',
      },
      { status: 409 }
    );
  }
  if (state.printifyOrders.length !== 1) {
    return NextResponse.json(
      {
        error:
          'This order needs a quick human touch to change - contact support@summitsoul.shop and we will swap it for you.',
      },
      { status: 409 }
    );
  }
  const printifyCopy = state.printifyOrders[0];

  // Only one parked money-moving change at a time.
  const pending = await prisma.pendingItemChange.findFirst({
    where: { shopifyOrderId: state.shopifyOrder.id, status: 'AWAITING_PAYMENT' },
  });
  if (pending) {
    return NextResponse.json(
      {
        error:
          'A change on this order is already waiting for payment - check your email for the payment link, or let it expire and try again.',
      },
      { status: 409 }
    );
  }

  // --- Validate EVERYTHING before touching anything -------------------------
  const line = state.shopifyOrder.lineItems.find((li) => li.id === body.lineItemId);
  if (!line) {
    return NextResponse.json({ error: 'That item is not on this order.' }, { status: 400 });
  }
  if (!line.productId) {
    return NextResponse.json(
      { error: 'This item cannot be changed automatically. Contact support@summitsoul.shop.' },
      { status: 409 }
    );
  }

  const shopifyClient = await createShopifyClient();
  if (!shopifyClient) {
    return NextResponse.json(
      { error: 'Changes are temporarily unavailable. Contact support@summitsoul.shop.' },
      { status: 503 }
    );
  }
  // Same product only: the new variant must exist on the product they bought.
  const product = await shopifyClient.getProductVariants(line.productId);
  const newVariant = product?.variants.find((v) => v.id === body.newVariantId);
  if (!newVariant) {
    return NextResponse.json(
      { error: 'That size/color is not available for this item.' },
      { status: 400 }
    );
  }
  if (!newVariant.availableForSale) {
    return NextResponse.json(
      { error: 'That size/color is currently unavailable.' },
      { status: 409 }
    );
  }
  if (newVariant.id === line.variantId) {
    return NextResponse.json(
      { error: 'Your order already has that size/color.' },
      { status: 400 }
    );
  }

  // Manually rerouted orders (regional print provider) must not be rebuilt
  // automatically - the recreate would land on the default provider.
  if (await hasActiveReroute(state.shopifyOrder.id)) {
    return NextResponse.json(
      {
        error:
          'This order needs a quick human touch to change - email support@summitsoul.shop and we will swap it for you.',
      },
      { status: 409 }
    );
  }

  // Money: same / refund / charge, all from Shopify's own numbers.
  const swapLines = state.shopifyOrder.lineItems.map((li) => ({
    full: parseFloat(li.originalUnitPrice || '0'),
    paid: parseFloat(li.discountedUnitPrice || li.originalUnitPrice || '0'),
    quantity: li.quantity,
  }));
  const changedIdx = state.shopifyOrder.lineItems.findIndex((li) => li.id === line.id);
  const money = computeSwapMoney(
    swapLines,
    swapLines[changedIdx],
    parseFloat(newVariant.price || '0')
  );
  const currency = state.shopifyOrder.totalPriceCurrency;

  // --- Deterministic Printify line mapping (BEFORE anything is committed) ---
  const origCopy = printifyCopy.order;
  if (!origCopy) {
    return NextResponse.json(
      { error: 'This order needs a quick human check. Contact support@summitsoul.shop.' },
      { status: 409 }
    );
  }
  const printify = await createPrintifyClient();
  if (!printify) {
    return NextResponse.json(
      { error: 'Changes are temporarily unavailable. Contact support@summitsoul.shop.' },
      { status: 503 }
    );
  }
  const map = await mapPrintifySwap(printify, origCopy, {
    itemTitle: line.title,
    oldVariantTitle: line.variantTitle || '',
    newVariantTitle: newVariant.title,
    quantity: line.quantity,
  });
  if (!map) {
    return NextResponse.json(
      {
        error:
          'We could not match that item automatically - email support@summitsoul.shop and we will swap it for you.',
      },
      { status: 409 }
    );
  }

  // Pricier swaps need enough runway before the production cutoff.
  let payBy: Date | null = null;
  if (money.kind === 'charge') {
    const cutoff = productionCutoff(new Date(state.shopifyOrder.createdAt));
    const deadline = Math.min(
      Date.now() + PAY_WINDOW_MAX_MS,
      cutoff.getTime() - PAY_BUFFER_BEFORE_CUTOFF_MS
    );
    if (deadline - Date.now() < PAY_WINDOW_MIN_MS) {
      return NextResponse.json(
        {
          error:
            'Your order goes to print very soon, so there is not enough time to collect the price difference. Email support@summitsoul.shop right away and we will try to catch it.',
        },
        { status: 409 }
      );
    }
    payBy = new Date(deadline);
  }

  const claimed = await consumeToken(token.id);
  if (!claimed) {
    return NextResponse.json(
      { error: 'This link has already been used. Request a new one to make another change.' },
      { status: 409 }
    );
  }

  const editShopify = () =>
    shopifyClient.editOrder({
      orderId: state.shopifyOrder.id,
      removeLineItemIds: [line.id],
      addItems: [
        {
          variantId: newVariant.id,
          quantity: line.quantity,
          discount: money.absorb > 0.001 ? money.absorb.toFixed(2) : undefined,
        },
      ],
      notifyCustomer: false,
      staffNote:
        money.kind === 'charge'
          ? `Self-service size/color change - awaiting payment of ${money.amount.toFixed(2)} ${currency}.`
          : 'Self-service size/color change before production.',
    });

  try {
    // ==================== PRICIER: park until paid =========================
    if (money.kind === 'charge' && payBy) {
      const editRes = await editShopify();
      if (!editRes.success) {
        await releaseToken(token.id);
        return NextResponse.json(
          {
            error:
              'We could not set up the change. Please try again or contact support@summitsoul.shop.',
          },
          { status: 502 }
        );
      }

      const invoice = await shopifyClient.sendOrderInvoice(
        state.shopifyOrder.id,
        `Your size/color change for order ${token.shopifyOrderName}: pay the ${money.amount.toFixed(2)} ${currency} difference here and we'll swap the item right away. If it isn't paid by our print cutoff, your order simply stays as originally placed.`
      );

      const row = await prisma.pendingItemChange.create({
        data: {
          shopifyOrderId: state.shopifyOrder.id,
          shopifyOrderName: token.shopifyOrderName,
          customerEmail: state.shopifyOrder.customerEmail || token.email,
          printifyOrderId: printifyCopy.id,
          lineItemId: line.id,
          quantity: line.quantity,
          itemTitle: line.title,
          oldVariantId: line.variantId || '',
          oldVariantTitle: line.variantTitle || '',
          oldUnitFull: line.originalUnitPrice || '0',
          removedPaid: money.removedPaid.toFixed(2),
          newVariantId: newVariant.id,
          newVariantTitle: newVariant.title,
          chargeAmount: money.amount.toFixed(2),
          payBy,
        },
      });

      if (!invoice.success) {
        // Edit is in but the payment email failed - a human must resend it
        // from the Shopify admin, or the watcher reverts at the deadline.
        await notifySelfServiceFailure({
          flow: 'item-change',
          orderName: token.shopifyOrderName,
          step: 'Send the Shopify payment link for a pricier swap',
          error: invoice.errors?.join('; ') || 'orderInvoiceSend failed',
          humanAction: `Open the order in Shopify and use "Send invoice" (balance ${money.amount.toFixed(2)} ${currency}). If unpaid by ${payBy.toISOString()}, the edit auto-reverts.`,
          customerEmail: state.shopifyOrder.customerEmail,
          detail: { shopifyOrderId: state.shopifyOrder.id, pendingItemChangeId: row.id },
        });
      }

      await logAction({
        threadId: null,
        userId: null,
        userName: 'Customer (self-service)',
        action: 'self_service_item_change_pending',
        summary: `Customer requested "${line.title}" ${line.variantTitle} -> ${newVariant.title} on ${token.shopifyOrderName} (+${money.amount.toFixed(2)} ${currency}, awaiting payment by ${payBy.toISOString()})`,
        orderName: token.shopifyOrderName,
        amountCents: Math.round(money.amount * 100),
        metadata: { shopifyOrderId: state.shopifyOrder.id, pendingItemChangeId: row.id },
      }).catch(() => undefined);

      return NextResponse.json({
        ok: true,
        awaitingPayment: true,
        amount: money.amount.toFixed(2),
        currency,
        payBy: payBy.toISOString(),
        message: `Almost done - the new option costs ${money.amount.toFixed(2)} ${currency} more. We just emailed you a secure payment link; your swap is applied the moment it's paid. If it isn't paid in time, your order simply stays as originally placed.`,
      });
    }

    // ============== SAME PRICE or CHEAPER: apply immediately ===============
    // 1) Printify first (fail-safe recreate + verify).
    const applied = await applyPrintifySwap(printify, {
      printifyOrderId: printifyCopy.id,
      origCopy,
      shopifyOrderId: state.shopifyOrder.id,
      shopifyOrderName: token.shopifyOrderName,
      map,
      itemTitle: line.title,
      newVariantTitle: newVariant.title,
    });
    if (!applied.success || !applied.newPrintifyOrderId) {
      if (applied.inProduction) {
        await releaseToken(token.id);
        return NextResponse.json(
          {
            error:
              'This order just started printing, so it can no longer be changed. Contact support@summitsoul.shop and we will help.',
          },
          { status: 409 }
        );
      }
      await notifySelfServiceFailure({
        flow: 'item-change',
        orderName: token.shopifyOrderName,
        step: `Recreate Printify order ${printifyCopy.id} with ${newVariant.title}`,
        error: applied.error || 'recreate failed',
        humanAction:
          'Nothing changed anywhere (recreate aborts safely). The customer wants ' +
          `"${line.title}" changed from "${line.variantTitle}" to "${newVariant.title}" - apply it in Printify by hand.`,
        customerEmail: state.shopifyOrder.customerEmail,
        detail: { shopifyOrderId: state.shopifyOrder.id },
      });
      await releaseToken(token.id);
      return NextResponse.json(
        {
          error:
            'We could not apply the change automatically. Our team has been notified and will make the swap for you - no action needed.',
        },
        { status: 502 }
      );
    }
    const newPrintifyOrderId = applied.newPrintifyOrderId;

    // 2) Shopify order edit so the receipt matches what will print.
    //    KEEP IN SYNC with the operator flow's absorb math in
    //    src/app/api/threads/[id]/orders/actions/route.ts (change_preproduction)
    //    - the shared formula lives in money.ts.
    let shopifyEditWarning: string | null = null;
    const editRes = await editShopify();
    if (!editRes.success) {
      shopifyEditWarning = editRes.errors?.join('; ') || 'order edit failed';
      await notifySelfServiceFailure({
        flow: 'item-change',
        orderName: token.shopifyOrderName,
        step: 'Edit the Shopify order line items after the Printify swap',
        error: shopifyEditWarning,
        humanAction:
          `Printify ${newPrintifyOrderId} already prints "${newVariant.title}" - only the Shopify receipt is stale. ` +
          `Swap line "${line.title} - ${line.variantTitle}" to "${newVariant.title}" in the Shopify admin.`,
        customerEmail: state.shopifyOrder.customerEmail,
        detail: { shopifyOrderId: state.shopifyOrder.id, newPrintifyOrderId },
      });
    }

    // 3) Cheaper item: refund the discounted difference automatically. Only
    //    when the edit landed - refunding against an unedited order would
    //    leave the receipt and the money out of sync.
    let refundedAmount: string | null = null;
    if (money.kind === 'refund' && !shopifyEditWarning) {
      const refundRes = await shopifyClient.refundOrder(state.shopifyOrder.id, {
        amount: money.amount.toFixed(2),
        reason: 'Self-service size/color change - cheaper item, refunding the difference',
        notify: true,
      });
      if (refundRes.success) {
        refundedAmount = refundRes.refundedAmount || money.amount.toFixed(2);
      } else {
        await notifySelfServiceFailure({
          flow: 'item-change',
          orderName: token.shopifyOrderName,
          step: `Refund the ${money.amount.toFixed(2)} ${currency} difference for a cheaper swap`,
          error: refundRes.errors?.join('; ') || 'refund failed',
          humanAction: `The swap itself is done (Printify ${newPrintifyOrderId}). Refund ${money.amount.toFixed(2)} ${currency} by hand.`,
          customerEmail: state.shopifyOrder.customerEmail,
          detail: { shopifyOrderId: state.shopifyOrder.id },
        });
      }
    }

    if (!applied.verified) {
      await notifySelfServiceFailure({
        flow: 'item-change',
        orderName: token.shopifyOrderName,
        step: 'Post-change verification (replacement contains the new variant)',
        error: `Could not confirm "${newVariant.title}" on Printify ${newPrintifyOrderId}`,
        humanAction: `Open Printify ${newPrintifyOrderId} and confirm one line is "${newVariant.title}" for "${line.title}".`,
        customerEmail: state.shopifyOrder.customerEmail,
        detail: { newPrintifyOrderId },
      });
    }

    // 4) Confirmations - never break the success path.
    const moneyLine =
      money.kind === 'refund'
        ? refundedAmount
          ? ` The new option is cheaper - a refund of ${refundedAmount} ${currency} is on its way to your original payment method.`
          : ` The new option is cheaper - your refund of ${money.amount.toFixed(2)} ${currency} is being processed.`
        : ' Same price - nothing to pay.';
    await sendSelfServiceChangeConfirmation({
      to: state.shopifyOrder.customerEmail || token.email,
      orderName: token.shopifyOrderName,
      heading: 'Size/color updated',
      changeSummary: `"${line.title}" on order ${token.shopifyOrderName} was changed from ${line.variantTitle || 'the original option'} to ${newVariant.title}.${moneyLine}`,
    }).catch((e) => console.error('[self-service/item-change] confirmation failed:', e));

    await logAction({
      threadId: null,
      userId: null,
      userName: 'Customer (self-service)',
      action: 'self_service_item_change',
      summary: `Customer self-changed "${line.title}" ${line.variantTitle} -> ${newVariant.title} on ${token.shopifyOrderName}${refundedAmount ? ` (refunded ${refundedAmount} ${currency})` : ''}${applied.verified ? ' (verified)' : ' (VERIFY FAILED)'}${shopifyEditWarning ? ' [Shopify edit failed]' : ''}`,
      orderName: token.shopifyOrderName,
      amountCents: refundedAmount ? Math.round(parseFloat(refundedAmount) * 100) : undefined,
      metadata: {
        shopifyOrderId: state.shopifyOrder.id,
        newPrintifyOrderId,
        verified: applied.verified,
        shopifyEditWarning,
        requestIp: token.requestIp,
      },
    }).catch(() => undefined);

    await sendSelfServiceSupportNotice({
      orderName: token.shopifyOrderName,
      customerEmail: state.shopifyOrder.customerEmail || token.email,
      action: `Item changed (self-service): ${line.variantTitle} -> ${newVariant.title}${refundedAmount ? ` (refunded ${refundedAmount} ${currency})` : ''}${applied.verified ? '' : ' - VERIFY FAILED, see alert'}`,
      printifyCancelled: true,
      total: `${state.shopifyOrder.totalPrice} ${currency}`,
      requestIp: token.requestIp,
    }).catch(() => undefined);

    return NextResponse.json({
      ok: true,
      message:
        money.kind === 'refund'
          ? `Done - your ${line.title} is now ${newVariant.title}. The new option is cheaper, so ${money.amount.toFixed(2)} ${currency} is being refunded to your original payment method. A confirmation email is on its way.`
          : `Done - your ${line.title} is now ${newVariant.title}. Same price, nothing else changes. A confirmation email is on its way.`,
    });
  } catch (err) {
    console.error('[self-service/item-change] execution error:', err);
    await notifySelfServiceFailure({
      flow: 'item-change',
      orderName: token.shopifyOrderName,
      step: 'Unexpected crash during item change',
      error: err instanceof Error ? err.message : 'Unknown error',
      humanAction:
        'Check the order on BOTH Printify and Shopify - the swap may have half-completed.',
      customerEmail: token.email,
      detail: { shopifyOrderId: token.shopifyOrderId },
    });
    // Deliberately NOT releasing the token: the crash may have landed after
    // the Printify recreate, and a blind retry would swap the fresh
    // replacement all over again. A human finishes from the alert.
    return NextResponse.json(
      {
        error:
          'Something went wrong partway through. Our team has been alerted and will finish your change by hand - no action needed on your side.',
      },
      { status: 500 }
    );
  }
}
