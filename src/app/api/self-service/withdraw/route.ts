/**
 * Self-service EU right of withdrawal.
 *
 *  GET  /api/self-service/withdraw?token=...  -> preview: validate token + return
 *       a safe order summary and current eligibility. Does NOT consume the token.
 *
 *  POST /api/self-service/withdraw  { token } -> execute: re-validate, atomically
 *       consume the token, cancel the linked Printify order if still possible,
 *       refund in full (cancel+refund if not yet shipped, plain full refund if it
 *       already shipped), then send the durable-medium withdrawal confirmation the
 *       EU directive requires and notify support@. Idempotent.
 *
 * This is the EU counterpart to the cancel route. Unlike a cancel, a withdrawal
 * is honoured even after the item has gone to production or shipped (the 14-day
 * statutory right). Per the operator decision, the refund is issued instantly in
 * all cases. Public, unauthenticated - ownership proven by the email magic link.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import { logAction } from '@/lib/audit';
import { createShopifyClient } from '@/lib/shopify';
import { createPrintifyClient, PrintifyClient } from '@/lib/printify';
import {
  getValidToken,
  consumeToken,
  releaseToken,
} from '@/lib/self-service/tokens';
import {
  loadOrderStateForToken,
  computeWithdrawEligibility,
  withdrawReasonMessage,
  isFulfilled,
  isEuOrder,
  maskEmail,
} from '@/lib/self-service/orders';
import {
  sendWithdrawalConfirmation,
  sendSelfServiceSupportNotice,
} from '@/lib/self-service/email';
import { notifySelfServiceFailure } from '@/lib/self-service/alerts';

function summarize(
  orderName: string,
  state: NonNullable<Awaited<ReturnType<typeof loadOrderStateForToken>>>
) {
  const itemCount = (state.shopifyOrder.lineItems || []).reduce(
    (n, li) => n + (li.quantity || 0),
    0
  );
  const eligibility = computeWithdrawEligibility(state.shopifyOrder);
  return {
    orderName,
    maskedEmail: maskEmail(state.shopifyOrder.customerEmail || ''),
    itemCount,
    total: `${state.shopifyOrder.totalPrice} ${state.shopifyOrder.totalPriceCurrency}`,
    shipped: isFulfilled(state.shopifyOrder),
    eligible: eligibility.eligible,
    reason: eligibility.reason,
    reasonMessage: eligibility.eligible ? '' : withdrawReasonMessage(eligibility.reason),
  };
}

// --- GET: preview (no side effects) -----------------------------------------
export async function GET(request: NextRequest) {
  const raw = new URL(request.url).searchParams.get('token') || '';
  const token = await getValidToken(raw);
  if (!token || token.purpose !== 'WITHDRAW') {
    return NextResponse.json(
      { error: 'This link is invalid or has expired. Please request a new one.' },
      { status: 400 }
    );
  }

  const state = await loadOrderStateForToken(token);
  if (!state) {
    return NextResponse.json(
      { error: 'We could not load this order. Contact support@summitsoul.shop.' },
      { status: 404 }
    );
  }

  return NextResponse.json(summarize(token.shopifyOrderName, state));
}

// --- POST: execute ----------------------------------------------------------
const postSchema = z.object({ token: z.string().min(1) });

export async function POST(request: NextRequest) {
  let raw: string;
  try {
    raw = postSchema.parse(await request.json()).token;
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const token = await getValidToken(raw);
  // MANAGE tokens (one-page portal) may also withdraw; the guard below keeps
  // the statutory flow exclusive to EU-shipping orders.
  if (!token || (token.purpose !== 'WITHDRAW' && token.purpose !== 'MANAGE')) {
    return NextResponse.json(
      { error: 'This link is invalid or has expired. Please request a new one.' },
      { status: 400 }
    );
  }

  // Re-load LIVE state and re-check eligibility at the real moment of action.
  const state = await loadOrderStateForToken(token);
  if (!state) {
    return NextResponse.json(
      { error: 'We could not load this order. Contact support@summitsoul.shop.' },
      { status: 404 }
    );
  }
  if (!isEuOrder(state.shopifyOrder)) {
    return NextResponse.json(
      { error: 'The withdrawal flow is for EU orders - please use the cancel option.' },
      { status: 400 }
    );
  }
  const eligibility = computeWithdrawEligibility(state.shopifyOrder);
  if (!eligibility.eligible) {
    return NextResponse.json(
      { error: withdrawReasonMessage(eligibility.reason), reason: eligibility.reason },
      { status: 409 }
    );
  }

  // Atomically consume FIRST so a double-submit can't refund twice. If anything
  // below fails, release the token so the customer can retry from the link.
  const claimed = await consumeToken(token.id);
  if (!claimed) {
    return NextResponse.json(
      { error: 'This link has already been used.' },
      { status: 409 }
    );
  }

  try {
    const shopifyClient = await createShopifyClient();
    if (!shopifyClient) {
      await releaseToken(token.id);
      return NextResponse.json(
        { error: 'Withdrawal is temporarily unavailable. Contact support@summitsoul.shop.' },
        { status: 503 }
      );
    }

    // 1) Cancel every live Printify copy that can still be stopped (saves a
    //    needless print run). Best-effort - the withdrawal is a statutory right
    //    and proceeds either way - but ANY copy that should or might have been
    //    stoppable and wasn't gets flagged to a human, including "we couldn't
    //    even try" (client unavailable, unreadable copy). No silent skips.
    let printifyCancelled = false;
    const stoppable = state.printifyOrders.filter(
      // Unreadable copies (order null) are included: they may well be
      // pre-production, and a failed cancel attempt on a printing order is
      // harmless. Only clearly-in-production copies are skipped.
      (c) => !c.order || PrintifyClient.canCancelOrder(c.order)
    );
    if (stoppable.length > 0) {
      const printify = await createPrintifyClient();
      if (!printify) {
        await notifySelfServiceFailure({
          flow: 'withdraw',
          orderName: token.shopifyOrderName,
          step: 'Stop the Printify copies before the refund',
          error: 'Printify client unavailable',
          humanAction: `The withdrawal + refund proceeded (statutory right). Stop these Printify orders by hand if still possible: ${stoppable.map((c) => c.id).join(', ')}.`,
          customerEmail: state.shopifyOrder.customerEmail,
          detail: { shopifyOrderId: state.shopifyOrder.id },
        });
      } else {
        for (const copy of stoppable) {
          const res = await printify.cancelOrder(copy.id);
          if (res.success) {
            printifyCancelled = true;
            await prisma.printifyOrderCache
              .update({
                where: { id: copy.id },
                data: { status: 'cancelled', lastSyncedAt: new Date() },
              })
              .catch(() => undefined);
          } else {
            await notifySelfServiceFailure({
              flow: 'withdraw',
              orderName: token.shopifyOrderName,
              step: `Stop Printify order ${copy.id} before the refund`,
              error: res.error || 'Printify refused the cancel',
              humanAction:
                'The withdrawal + refund proceeded (statutory right). Try to stop the print in Printify by hand so it does not produce needlessly.',
              customerEmail: state.shopifyOrder.customerEmail,
              detail: { shopifyOrderId: state.shopifyOrder.id },
            });
          }
        }
      }
    }

    // 2) Refund in full. If the order hasn't shipped, cancel + refund (also frees
    //    inventory); if it already shipped, issue a full refund without cancelling
    //    the fulfillment.
    const shipped = isFulfilled(state.shopifyOrder);
    let refundOk: boolean;
    let refundErrors: string[] | undefined;
    if (!shipped) {
      const res = await shopifyClient.cancelOrder(
        state.shopifyOrder.id,
        'CUSTOMER',
        'ORIGINAL',
        'EU right of withdrawal via self-service portal',
        true
      );
      refundOk = res.success;
      refundErrors = res.errors;
    } else {
      const res = await shopifyClient.refundOrder(state.shopifyOrder.id, {
        amount: state.shopifyOrder.totalPrice,
        reason: 'EU right of withdrawal via self-service portal',
        notify: true,
      });
      refundOk = res.success;
      refundErrors = res.errors;
    }

    if (!refundOk) {
      // Let the customer retry from the link; a Printify cancel that already
      // happened is safe to leave cancelled. Alert a human in case they never
      // retry - a withdrawal without its refund is a legal problem, not a log line.
      await notifySelfServiceFailure({
        flow: 'withdraw',
        orderName: token.shopifyOrderName,
        step: shipped ? 'Full refund (order already shipped)' : 'Cancel + refund the Shopify order',
        error: refundErrors?.join('; ') || 'Refund failed',
        humanAction:
          'EU withdrawal was requested but the refund did NOT go through. If the customer does not retry, issue the full refund by hand - the 14-day right stands regardless.',
        customerEmail: state.shopifyOrder.customerEmail,
        detail: { shopifyOrderId: state.shopifyOrder.id, printifyCancelled },
      });
      await releaseToken(token.id);
      console.error('[self-service/withdraw] refund failed:', refundErrors);
      return NextResponse.json(
        {
          error:
            'We could not complete your withdrawal automatically. Please try again or contact support@summitsoul.shop - your right of withdrawal still stands.',
        },
        { status: 502 }
      );
    }

    // The withdrawal also voids any swap parked on a payment link.
    await prisma.pendingItemChange
      .updateMany({
        where: { shopifyOrderId: state.shopifyOrder.id, status: 'AWAITING_PAYMENT' },
        data: { status: 'CANCELLED' },
      })
      .catch(() => undefined);

    const total = `${state.shopifyOrder.totalPrice} ${state.shopifyOrder.totalPriceCurrency}`;
    const customerEmail = state.shopifyOrder.customerEmail || token.email;

    // 3) Durable-medium acknowledgment to the customer (legal requirement),
    //    audit log, and support notice. None of these may break the success path.
    await sendWithdrawalConfirmation({
      to: customerEmail,
      orderName: token.shopifyOrderName,
      total,
      shipped,
    }).catch((e) => console.error('[self-service/withdraw] confirmation email failed:', e));

    await logAction({
      threadId: null,
      userId: null,
      userName: 'Customer (self-service)',
      action: 'self_service_withdraw',
      summary: `Customer exercised EU right of withdrawal + refunded ${token.shopifyOrderName} (${shipped ? 'shipped - refund only' : 'cancelled + refunded'}; Printify ${printifyCancelled ? 'cancelled' : 'not cancelled'})`,
      orderName: token.shopifyOrderName,
      metadata: {
        shopifyOrderId: state.shopifyOrder.id,
        printifyOrderId: state.printifyOrderId,
        printifyCancelled,
        shipped,
        requestIp: token.requestIp,
      },
    }).catch(() => undefined);

    await sendSelfServiceSupportNotice({
      orderName: token.shopifyOrderName,
      customerEmail,
      action: shipped
        ? 'EU withdrawal - refunded (shipped, awaiting return)'
        : 'EU withdrawal - cancelled + refunded',
      printifyCancelled,
      total,
      requestIp: token.requestIp,
    }).catch((e) => console.error('[self-service/withdraw] support notice failed:', e));

    return NextResponse.json({
      ok: true,
      message: shipped
        ? 'Your withdrawal is confirmed and a full refund to your original payment method is on its way. Since your order already shipped, please return the item - check your email for details. A confirmation email is coming too.'
        : 'Your withdrawal is confirmed and a refund to your original payment method is on its way. A confirmation email is coming too.',
    });
  } catch (err) {
    console.error('[self-service/withdraw] execution error:', err);
    await notifySelfServiceFailure({
      flow: 'withdraw',
      orderName: token.shopifyOrderName,
      step: 'Unexpected crash during withdrawal',
      error: err instanceof Error ? err.message : 'Unknown error',
      humanAction:
        'Check the order on BOTH Printify and Shopify - the withdrawal may have half-completed before the crash. The refund must be issued either way.',
      customerEmail: token.email,
      detail: { shopifyOrderId: token.shopifyOrderId },
    });
    await releaseToken(token.id);
    return NextResponse.json(
      { error: 'Something went wrong. Please try again or contact support@summitsoul.shop.' },
      { status: 500 }
    );
  }
}
