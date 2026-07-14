/**
 * POST /api/self-service/item-change
 *   { token, changes: [{ lineItemId, newVariantId }, ...] }
 *   (legacy: { token, lineItemId, newVariantId } - treated as a 1-item batch)
 *
 * Customer swaps the size/color of ONE OR MORE line items BEFORE the order
 * goes to print. Same product per line. The whole batch settles as a single
 * NET difference (Pati 2026-07-14):
 *
 *  - NET SAME: apply immediately (one Printify recreate, one Shopify edit).
 *  - NET CHEAPER: apply immediately + auto-refund the net difference.
 *  - NET PRICIER: commit the Shopify edit (balance = net), send Shopify's own
 *    payment link, and park a PendingItemChange holding the whole batch.
 *    Printify stays UNTOUCHED until the balance is paid; unpaid by the
 *    deadline -> the edit auto-reverts and the originals print.
 *
 * Everything is validated server-side BEFORE anything is committed, and the
 * Printify mapping is deterministic and distinct-per-line (see item-swap.ts).
 * Gated by the launch gate.
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
  issueContinuationToken,
} from '@/lib/self-service/tokens';
import { manageFlowAllowed } from '@/lib/self-service/gate';
import {
  loadOrderStateForToken,
  reasonMessage,
  hasActiveReroute,
} from '@/lib/self-service/orders';
import {
  mapPrintifySwap,
  applyPrintifySwap,
  toSwapInputs,
  type BatchLineChange,
} from '@/lib/self-service/item-swap';
import { computeSwapMoney } from '@/lib/self-service/money';
import { productionCutoff } from '@/lib/self-service/cutoff';
import { notifySelfServiceFailure } from '@/lib/self-service/alerts';
import { selfServiceMonitor } from '@/lib/self-service/monitor';
import {
  sendSelfServiceSupportNotice,
  sendSelfServiceChangeConfirmation,
} from '@/lib/self-service/email';

const changeSchema = z.object({
  lineItemId: z.string().min(1),
  newVariantId: z.string().min(1),
});
const bodySchema = z
  .object({
    token: z.string().min(1),
    // New multi-item shape; legacy single fields accepted for back-compat.
    changes: z.array(changeSchema).min(1).max(20).optional(),
    lineItemId: z.string().min(1).optional(),
    newVariantId: z.string().min(1).optional(),
  })
  .refine((b) => b.changes || (b.lineItemId && b.newVariantId), {
    message: 'changes or lineItemId+newVariantId required',
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
  const requested = body.changes ?? [
    { lineItemId: body.lineItemId as string, newVariantId: body.newVariantId as string },
  ];
  // No duplicate line ids in one batch (would double-remove the same line).
  if (new Set(requested.map((c) => c.lineItemId)).size !== requested.length) {
    return NextResponse.json(
      { error: 'That request tried to change the same item twice. Please try again.' },
      { status: 400 }
    );
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

  const shopifyClient = await createShopifyClient();
  if (!shopifyClient) {
    return NextResponse.json(
      { error: 'Changes are temporarily unavailable. Contact support@summitsoul.shop.' },
      { status: 503 }
    );
  }
  const currency = state.shopifyOrder.totalPriceCurrency;

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

  // --- Validate EVERY change before touching anything -----------------------
  // The order-wide discount rate is derived once from ALL lines (money.ts).
  const swapLines = state.shopifyOrder.lineItems.map((li) => ({
    full: parseFloat(li.originalUnitPrice || '0'),
    paid: parseFloat(li.discountedUnitPrice || li.originalUnitPrice || '0'),
    quantity: li.quantity,
  }));
  const productCache = new Map<
    string,
    NonNullable<Awaited<ReturnType<typeof shopifyClient.getProductVariants>>>
  >();
  const getProduct = async (pid: string) => {
    if (!productCache.has(pid)) {
      const p = await shopifyClient.getProductVariants(pid);
      if (p) productCache.set(pid, p);
    }
    return productCache.get(pid) ?? null;
  };

  const batch: BatchLineChange[] = [];
  // A single first-item image for the confirmation email.
  let firstImageUrl: string | null = null;
  for (const req of requested) {
    const line = state.shopifyOrder.lineItems.find((li) => li.id === req.lineItemId);
    if (!line) {
      return NextResponse.json({ error: 'That item is not on this order.' }, { status: 400 });
    }
    if (!line.productId) {
      return NextResponse.json(
        { error: 'This item cannot be changed automatically. Contact support@summitsoul.shop.' },
        { status: 409 }
      );
    }
    const product = await getProduct(line.productId);
    const newVariant = product?.variants.find((v) => v.id === req.newVariantId);
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

    const idx = state.shopifyOrder.lineItems.findIndex((li) => li.id === line.id);
    const money = computeSwapMoney(swapLines, swapLines[idx], parseFloat(newVariant.price || '0'));
    if (firstImageUrl === null) firstImageUrl = newVariant.imageUrl || null;
    batch.push({
      lineItemId: line.id,
      itemTitle: line.title,
      oldVariantId: line.variantId || '',
      oldVariantTitle: line.variantTitle || '',
      oldUnitFull: line.originalUnitPrice || '0',
      removedPaid: money.removedPaid.toFixed(2),
      newVariantId: newVariant.id,
      newVariantTitle: newVariant.title,
      quantity: line.quantity,
      absorb: money.absorb > 0.001 ? money.absorb.toFixed(2) : '0',
    });
  }

  // --- Exact NET money: run the WHOLE batch through Shopify's calculator ----
  const calc = await shopifyClient.previewOrderEditSwap({
    orderId: state.shopifyOrder.id,
    currencyCode: currency,
    changes: batch.map((c) => ({
      removeLineItemId: c.lineItemId,
      addVariantId: c.newVariantId,
      quantity: c.quantity,
      discount: parseFloat(c.absorb) > 0.001 ? c.absorb : undefined,
    })),
  });
  if (!calc.success || !calc.newTotalPrice) {
    return NextResponse.json(
      {
        error:
          'We could not compute the exact price difference right now. Please try again in a minute or contact support@summitsoul.shop.',
      },
      { status: 502 }
    );
  }
  const totalDelta =
    Math.round(
      (parseFloat(calc.newTotalPrice) - parseFloat(state.shopifyOrder.totalPrice)) * 100
    ) / 100;
  const exactKind: 'same' | 'refund' | 'charge' =
    Math.abs(totalDelta) < 0.01 ? 'same' : totalDelta > 0 ? 'charge' : 'refund';
  const exactAmount = Math.abs(totalDelta);
  const origPaidTotal = swapLines.reduce((s, l) => s + l.paid * l.quantity, 0);
  if (exactKind === 'charge' && origPaidTotal <= 0.01) {
    return NextResponse.json(
      {
        error:
          'This order was fully discounted, so a price-different change needs a human look - email support@summitsoul.shop and we will sort it out.',
      },
      { status: 409 }
    );
  }

  // --- Deterministic Printify mapping for the whole batch (before commit) ---
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
  const map = await mapPrintifySwap(printify, origCopy, toSwapInputs(batch));
  if (!map) {
    return NextResponse.json(
      {
        error:
          'We could not match those items automatically - email support@summitsoul.shop and we will swap them for you.',
      },
      { status: 409 }
    );
  }

  // Pricier batches need enough runway before the production cutoff.
  let payBy: Date | null = null;
  if (exactKind === 'charge') {
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

  // Human-readable summary of what changed, for messages/logs.
  const summary =
    batch.length === 1
      ? `"${batch[0].itemTitle}" ${batch[0].oldVariantTitle} -> ${batch[0].newVariantTitle}`
      : `${batch.length} items (${batch
          .map((c) => `${c.itemTitle}: ${c.oldVariantTitle} -> ${c.newVariantTitle}`)
          .join('; ')})`;
  const noun = batch.length === 1 ? 'item' : 'items';

  const editShopify = () =>
    shopifyClient.editOrder({
      orderId: state.shopifyOrder.id,
      removeLineItemIds: batch.map((c) => c.lineItemId),
      addItems: batch.map((c) => ({
        variantId: c.newVariantId,
        quantity: c.quantity,
        discount: parseFloat(c.absorb) > 0.001 ? c.absorb : undefined,
      })),
      notifyCustomer: false,
      staffNote:
        exactKind === 'charge'
          ? `Self-service change - awaiting payment of ${exactAmount.toFixed(2)} ${currency}.`
          : 'Self-service size/color change before production.',
    });

  try {
    // ==================== NET PRICIER: park until paid =====================
    if (exactKind === 'charge' && payBy) {
      // Row FIRST so the watcher owns every outcome; partial unique index makes
      // "one parked change per order" atomic against a concurrent request.
      const preEditLineIds = JSON.stringify(state.shopifyOrder.lineItems.map((li) => li.id));
      let row: { id: string };
      try {
        row = await prisma.pendingItemChange.create({
          data: {
            shopifyOrderId: state.shopifyOrder.id,
            shopifyOrderName: token.shopifyOrderName,
            customerEmail: state.shopifyOrder.customerEmail || token.email,
            printifyOrderId: printifyCopy.id,
            // Flat columns mirror the FIRST change (display / legacy readers);
            // `changes` holds the full batch the watcher acts on.
            lineItemId: batch[0].lineItemId,
            quantity: batch[0].quantity,
            itemTitle: batch[0].itemTitle,
            oldVariantId: batch[0].oldVariantId,
            oldVariantTitle: batch[0].oldVariantTitle,
            oldUnitFull: batch[0].oldUnitFull,
            removedPaid: batch[0].removedPaid,
            newVariantId: batch[0].newVariantId,
            newVariantTitle: batch[0].newVariantTitle,
            changes: JSON.parse(JSON.stringify(batch)),
            chargeAmount: exactAmount.toFixed(2),
            preEditLineIds,
            payBy,
          },
        });
      } catch {
        await releaseToken(token.id);
        return NextResponse.json(
          {
            error:
              'A change on this order is already waiting for payment - check your email for the payment link, or let it expire and try again.',
          },
          { status: 409 }
        );
      }

      const editRes = await editShopify();
      if (!editRes.success) {
        await prisma.pendingItemChange
          .update({
            where: { id: row.id },
            data: { status: 'CANCELLED', error: 'Shopify edit failed before commit' },
          })
          .catch(() => undefined);
        await releaseToken(token.id);
        return NextResponse.json(
          {
            error:
              'We could not set up the change. Please try again or contact support@summitsoul.shop.',
          },
          { status: 502 }
        );
      }

      const payWindowMin = Math.max(1, Math.round((payBy.getTime() - Date.now()) / 60000));
      const payWindowHuman =
        payWindowMin >= 90
          ? `about ${Math.round(payWindowMin / 60)} hours`
          : `about ${payWindowMin} minutes`;
      const invoice = await shopifyClient.sendOrderInvoice(
        state.shopifyOrder.id,
        `Your change for order ${token.shopifyOrderName}: pay the ${exactAmount.toFixed(2)} ${currency} difference (any tax difference included) here within ${payWindowHuman} and we'll apply it right away. If it isn't paid in time, no worries - your order simply stays exactly as you originally placed it, and nothing is charged.`
      );

      if (!invoice.success) {
        await notifySelfServiceFailure({
          flow: 'item-change',
          orderName: token.shopifyOrderName,
          step: 'Send the Shopify payment link for a pricier change',
          error: invoice.errors?.join('; ') || 'orderInvoiceSend failed',
          humanAction: `Open the order in Shopify and use "Send invoice" (balance ${exactAmount.toFixed(2)} ${currency}). If unpaid by ${payBy.toISOString()}, the edit auto-reverts.`,
          customerEmail: state.shopifyOrder.customerEmail,
          detail: { shopifyOrderId: state.shopifyOrder.id, pendingItemChangeId: row.id },
        });
      }

      await selfServiceMonitor({
        text: `:hourglass_flowing_sand: ${token.shopifyOrderName} - Change requested (${noun}): ${summary} (+${exactAmount.toFixed(2)} ${currency}), payment link sent, expires ${payBy.toISOString()} | ${state.shopifyOrder.customerEmail || token.email}`,
        shopifyOrderId: state.shopifyOrder.id,
        printifyOrderId: printifyCopy.id,
      });

      await logAction({
        threadId: null,
        userId: null,
        userName: 'Customer (self-service)',
        action: 'self_service_item_change_pending',
        summary: `Customer requested ${summary} on ${token.shopifyOrderName} (+${exactAmount.toFixed(2)} ${currency}, awaiting payment by ${payBy.toISOString()})`,
        orderName: token.shopifyOrderName,
        amountCents: Math.round(exactAmount * 100),
        metadata: { shopifyOrderId: state.shopifyOrder.id, pendingItemChangeId: row.id },
      }).catch(() => undefined);

      return NextResponse.json({
        ok: true,
        awaitingPayment: true,
        amount: exactAmount.toFixed(2),
        currency,
        payBy: payBy.toISOString(),
        message: `Almost done - your ${noun} cost exactly ${exactAmount.toFixed(2)} ${currency} more altogether (any tax difference included). We just emailed you a secure payment link; your change is applied the moment it's paid. If it isn't paid within ${payWindowHuman}, your order simply stays as originally placed and nothing is charged.`,
        nextToken: await issueContinuationToken(token),
      });
    }

    // ============== NET SAME or CHEAPER: apply immediately =================
    const applied = await applyPrintifySwap(printify, {
      printifyOrderId: printifyCopy.id,
      origCopy,
      shopifyOrderId: state.shopifyOrder.id,
      shopifyOrderName: token.shopifyOrderName,
      map,
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
        step: `Recreate Printify order ${printifyCopy.id}`,
        error: applied.error || 'recreate failed',
        humanAction:
          'Nothing changed anywhere (recreate aborts safely). The customer wants: ' +
          `${summary} - apply it in Printify by hand.`,
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

    // Shopify order edit so the receipt matches what will print.
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
          `Printify ${newPrintifyOrderId} already prints the new choice(s) - only the Shopify receipt is stale. ` +
          `Apply in the Shopify admin: ${summary}.`,
        customerEmail: state.shopifyOrder.customerEmail,
        detail: { shopifyOrderId: state.shopifyOrder.id, newPrintifyOrderId },
      });
    }

    // Net cheaper: refund the EXACT Shopify-calculated net difference. Only
    // when the edit landed (else receipt and money go out of sync).
    let refundedAmount: string | null = null;
    let refundFailed = false;
    if (exactKind === 'refund' && !shopifyEditWarning) {
      const refundRes = await shopifyClient.refundOrder(state.shopifyOrder.id, {
        amount: exactAmount.toFixed(2),
        reason: 'Self-service change - net cheaper, refunding the difference',
        notify: true,
      });
      if (refundRes.success) {
        refundedAmount = refundRes.refundedAmount || exactAmount.toFixed(2);
      } else {
        refundFailed = true;
        await notifySelfServiceFailure({
          flow: 'item-change',
          orderName: token.shopifyOrderName,
          step: `Refund the ${exactAmount.toFixed(2)} ${currency} net difference`,
          error: refundRes.errors?.join('; ') || 'refund failed (split-tender orders may need a manual split)',
          humanAction: `The change itself is done (Printify ${newPrintifyOrderId}). Refund ${exactAmount.toFixed(2)} ${currency} by hand.`,
          customerEmail: state.shopifyOrder.customerEmail,
          detail: { shopifyOrderId: state.shopifyOrder.id },
        });
      }
    }

    if (!applied.verified) {
      await notifySelfServiceFailure({
        flow: 'item-change',
        orderName: token.shopifyOrderName,
        step: 'Post-change verification (replacement contains the new choices)',
        error: `Could not confirm the new choices on Printify ${newPrintifyOrderId}`,
        humanAction: `Open Printify ${newPrintifyOrderId} and confirm: ${summary}.`,
        customerEmail: state.shopifyOrder.customerEmail,
        detail: { newPrintifyOrderId },
      });
    }

    // Confirmations - never break the success path.
    const moneyLine =
      exactKind === 'refund'
        ? refundedAmount
          ? ` Your new choices are cheaper - a refund of ${refundedAmount} ${currency} is on its way to your original payment method.`
          : ` Your new choices are cheaper - your refund of ${exactAmount.toFixed(2)} ${currency} needs a quick manual step on our side. Our team is on it; nothing needed from you.`
        : ' Same price - nothing to pay.';
    const changeList = batch
      .map((c) => `${c.itemTitle}: ${c.oldVariantTitle} -> ${c.newVariantTitle}`)
      .join('; ');
    await sendSelfServiceChangeConfirmation({
      to: state.shopifyOrder.customerEmail || token.email,
      orderName: token.shopifyOrderName,
      heading: batch.length === 1 ? 'Size/color updated' : 'Your order was updated',
      changeSummary: `On order ${token.shopifyOrderName}: ${changeList}.${moneyLine}`,
      imageUrl: batch.length === 1 ? firstImageUrl : null,
    }).catch((e) => console.error('[self-service/item-change] confirmation failed:', e));

    await logAction({
      threadId: null,
      userId: null,
      userName: 'Customer (self-service)',
      action: 'self_service_item_change',
      summary: `Customer self-changed ${summary} on ${token.shopifyOrderName}${refundedAmount ? ` (refunded ${refundedAmount} ${currency})` : ''}${applied.verified ? ' (verified)' : ' (VERIFY FAILED)'}${shopifyEditWarning ? ' [Shopify edit failed]' : ''}`,
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
      action: `Item change (self-service): ${summary}${refundedAmount ? ` (refunded ${refundedAmount} ${currency})` : ''}${applied.verified ? '' : ' - VERIFY FAILED, see alert'}`,
      printifyCancelled: true,
      total: `${state.shopifyOrder.totalPrice} ${currency}`,
      requestIp: token.requestIp,
      shopifyOrderId: state.shopifyOrder.id,
      printifyOrderId: newPrintifyOrderId,
    }).catch(() => undefined);

    return NextResponse.json({
      ok: true,
      message:
        exactKind === 'refund'
          ? refundFailed
            ? `Done - your ${noun} were updated. Your refund of ${exactAmount.toFixed(2)} ${currency} needs a quick manual step on our side - our team has been notified and is on it. A confirmation email is on its way.`
            : `Done - your ${noun} were updated. Your new choices are cheaper, so ${refundedAmount || exactAmount.toFixed(2)} ${currency} is being refunded to your original payment method. A confirmation email is on its way.`
          : `Done - your ${noun} were updated. Same price, nothing else changes. A confirmation email is on its way.`,
      nextToken: await issueContinuationToken(token),
    });
  } catch (err) {
    console.error('[self-service/item-change] execution error:', err);
    await notifySelfServiceFailure({
      flow: 'item-change',
      orderName: token.shopifyOrderName,
      step: 'Unexpected crash during item change',
      error: err instanceof Error ? err.message : 'Unknown error',
      humanAction:
        'Check the order on BOTH Printify and Shopify - the change may have half-completed. Intended: ' +
        summary,
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
