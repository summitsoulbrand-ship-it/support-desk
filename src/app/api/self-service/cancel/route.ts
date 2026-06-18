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
import { createPrintifyClient, PrintifyClient } from '@/lib/printify';
import {
  getValidToken,
  consumeToken,
  releaseToken,
} from '@/lib/self-service/tokens';
import {
  loadOrderStateForToken,
  maskEmail,
  reasonMessage,
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
  if (token.purpose !== 'CANCEL') {
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

    // 1) Cancel the linked Printify order if it is still cancellable.
    let printifyCancelled = false;
    if (state.printifyOrderId && state.printifyOrder) {
      if (PrintifyClient.canCancelOrder(state.printifyOrder)) {
        const printify = await createPrintifyClient();
        if (printify) {
          const res = await printify.cancelOrder(state.printifyOrderId);
          printifyCancelled = res.success;
          if (res.success) {
            await prisma.printifyOrderCache
              .update({
                where: { id: state.printifyOrderId },
                data: { status: 'cancelled', lastSyncedAt: new Date() },
              })
              .catch(() => undefined);
          }
        }
      }
    }

    // 2) Cancel + refund the Shopify order (to original payment), notify buyer.
    const shopify = await shopifyClient.cancelOrder(
      state.shopifyOrder.id,
      'CUSTOMER',
      'ORIGINAL',
      'Cancelled by customer via self-service portal',
      true
    );

    if (!shopify.success) {
      // Shopify is the source of truth for the refund; if it failed, let them
      // retry (the Printify cancel, if it happened, is safe to leave cancelled).
      await releaseToken(token.id);
      return NextResponse.json(
        {
          error:
            'We could not complete the cancellation. Please try again or contact support@summitsoul.shop.',
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
    await releaseToken(token.id);
    return NextResponse.json(
      { error: 'Something went wrong. Please try again or contact support@summitsoul.shop.' },
      { status: 500 }
    );
  }
}
