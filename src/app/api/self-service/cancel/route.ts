/**
 * Self-service cancel.
 *
 *  GET  /api/self-service/cancel?token=...  -> preview: validate token + return a
 *       safe order summary and current eligibility. Does NOT consume the token.
 *
 *  POST /api/self-service/cancel  { token } -> execute: re-validate, re-check
 *       production state LIVE, atomically consume the token, cancel + refund
 *       (Shopify) and cancel the linked Printify order if still possible, then
 *       email support@. Idempotent: a consumed token can never run twice.
 *
 * Public, unauthenticated. Ownership was proven by the email magic link; the
 * blast radius is bounded because the refund always goes to the original
 * payment method.
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
import { notifySelfServiceFailure } from '@/lib/self-service/alerts';
import {
  loadOrderStateForToken,
  maskEmail,
  reasonMessage,
  isEuOrder,
} from '@/lib/self-service/orders';
import { sendSelfServiceSupportNotice } from '@/lib/self-service/email';

function summarize(orderName: string, state: NonNullable<Awaited<ReturnType<typeof loadOrderStateForToken>>>) {
  const itemCount = (state.shopifyOrder.lineItems || []).reduce(
    (n, li) => n + (li.quantity || 0),
    0
  );
  return {
    orderName,
    maskedEmail: maskEmail(state.shopifyOrder.customerEmail || ''),
    itemCount,
    total: `${state.shopifyOrder.totalPrice} ${state.shopifyOrder.totalPriceCurrency}`,
    createdAt: state.shopifyOrder.createdAt,
    eligible: state.eligibility.eligible,
    reason: state.eligibility.reason,
    reasonMessage: state.eligibility.eligible
      ? ''
      : reasonMessage(state.eligibility.reason),
  };
}

// --- GET: preview (no side effects) -----------------------------------------
export async function GET(request: NextRequest) {
  const raw = new URL(request.url).searchParams.get('token') || '';
  const token = await getValidToken(raw);
  if (!token) {
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
  if (!token) {
    return NextResponse.json(
      { error: 'This link is invalid or has expired. Please request a new one.' },
      { status: 400 }
    );
  }
  // MANAGE tokens (one-page portal) may also cancel; the EU guard below keeps
  // EU orders on the statutory withdrawal flow regardless of which button was hit.
  if (token.purpose !== 'CANCEL' && token.purpose !== 'MANAGE') {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  // Re-load LIVE state and re-check the cutoff at the real moment of action.
  const state = await loadOrderStateForToken(token);
  if (!state) {
    return NextResponse.json(
      { error: 'We could not load this order. Contact support@summitsoul.shop.' },
      { status: 404 }
    );
  }
  if (isEuOrder(state.shopifyOrder)) {
    return NextResponse.json(
      { error: 'EU orders use the withdrawal flow - please use the withdraw option.' },
      { status: 400 }
    );
  }
  if (!state.eligibility.eligible) {
    return NextResponse.json(
      {
        error: reasonMessage(state.eligibility.reason),
        reason: state.eligibility.reason,
      },
      { status: 409 }
    );
  }

  // Atomically consume FIRST so a double-submit can't cancel twice. If anything
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
        { error: 'Cancellation is temporarily unavailable. Contact support@summitsoul.shop.' },
        { status: 503 }
      );
    }

    // 1) Cancel EVERY live Printify copy FIRST, so nothing can print or ship.
    //    Eligibility already verified each copy is pre-production; if any
    //    cancel still fails, ABORT with the money untouched - refunding a
    //    customer whose shirt still prints is the one outcome this flow must
    //    never produce. A retry from the same link picks up where this left
    //    off (already-cancelled copies resolve as cancelled and are skipped).
    const cancelledIds: string[] = [];
    if (state.printifyOrders.length > 0) {
      const printify = await createPrintifyClient();
      if (!printify) {
        await releaseToken(token.id);
        return NextResponse.json(
          { error: 'Cancellation is temporarily unavailable. Contact support@summitsoul.shop.' },
          { status: 503 }
        );
      }
      for (const copy of state.printifyOrders) {
        const res = await printify.cancelOrder(copy.id);
        if (!res.success) {
          await notifySelfServiceFailure({
            flow: 'cancel',
            orderName: token.shopifyOrderName,
            step: `Cancel Printify order ${copy.id}`,
            error: res.error || 'Printify refused the cancel',
            humanAction:
              cancelledIds.length > 0
                ? `Half-done: Printify ${cancelledIds.join(', ')} cancelled, ${copy.id} NOT cancelled, Shopify NOT refunded. Cancel the remaining copy in Printify and refund the Shopify order, or check whether the customer retried.`
                : 'Nothing was changed. Check the order in Printify - it may have just entered production.',
            customerEmail: state.shopifyOrder.customerEmail,
            detail: { shopifyOrderId: state.shopifyOrder.id },
          });
          await releaseToken(token.id);
          return NextResponse.json(
            {
              error:
                'We could not cancel your order automatically. Please try again in a minute or contact support@summitsoul.shop - our team has been notified and will make it right.',
            },
            { status: 502 }
          );
        }
        cancelledIds.push(copy.id);
        await prisma.printifyOrderCache
          .update({
            where: { id: copy.id },
            data: { status: 'cancelled', lastSyncedAt: new Date() },
          })
          .catch(() => undefined);
      }
    }
    const printifyCancelled = cancelledIds.length > 0;

    // 2) Cancel + refund the Shopify order (to original payment), notify buyer.
    const shopify = await shopifyClient.cancelOrder(
      state.shopifyOrder.id,
      'CUSTOMER',
      'ORIGINAL',
      'Cancelled by customer via self-service portal',
      true
    );

    if (!shopify.success) {
      // Printify is fully cancelled (nothing will print) but the money has NOT
      // moved. Let the customer retry from the link, and alert a human in case
      // they never do - this half-state must not die in a server log.
      await notifySelfServiceFailure({
        flow: 'cancel',
        orderName: token.shopifyOrderName,
        step: 'Cancel + refund the Shopify order',
        error: shopify.errors?.join('; ') || 'Shopify cancelOrder failed',
        humanAction: `Printify side is fully cancelled (${cancelledIds.join(', ') || 'no copies existed'}) - nothing will print. If the customer does not retry, cancel + refund the Shopify order by hand.`,
        customerEmail: state.shopifyOrder.customerEmail,
        detail: { shopifyOrderId: state.shopifyOrder.id, cancelledIds },
      });
      await releaseToken(token.id);
      return NextResponse.json(
        {
          error:
            'Your items were stopped from printing, but the refund did not go through yet. Please click the button again - if it keeps failing, our team has already been notified and will finish the refund for you.',
        },
        { status: 502 }
      );
    }

    // 3) Audit + notify support (never let these break the success path).
    await logAction({
      threadId: null,
      userId: null,
      userName: 'Customer (self-service)',
      action: 'self_service_cancel',
      summary: `Customer self-cancelled + refunded ${token.shopifyOrderName} (Printify ${printifyCancelled ? 'cancelled' : 'not cancelled'})`,
      orderName: token.shopifyOrderName,
      metadata: {
        shopifyOrderId: state.shopifyOrder.id,
        printifyOrderId: state.printifyOrderId,
        printifyCancelled,
        requestIp: token.requestIp,
      },
    }).catch(() => undefined);

    await sendSelfServiceSupportNotice({
      orderName: token.shopifyOrderName,
      customerEmail: state.shopifyOrder.customerEmail || token.email,
      action: 'Cancelled + refunded',
      printifyCancelled,
      total: `${state.shopifyOrder.totalPrice} ${state.shopifyOrder.totalPriceCurrency}`,
      requestIp: token.requestIp,
    }).catch((e) => console.error('[self-service/cancel] support notice failed:', e));

    return NextResponse.json({
      ok: true,
      message:
        'Your order has been cancelled and a refund to your original payment method is on its way. A confirmation email is coming too.',
    });
  } catch (err) {
    console.error('[self-service/cancel] execution error:', err);
    await notifySelfServiceFailure({
      flow: 'cancel',
      orderName: token.shopifyOrderName,
      step: 'Unexpected crash during cancel',
      error: err instanceof Error ? err.message : 'Unknown error',
      humanAction:
        'Check the order on BOTH Printify and Shopify - the cancel may have half-completed before the crash.',
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
