/**
 * POST /api/self-service/item-change  { token, lineItemId, newVariantId }
 *
 * Customer swaps a line item's size/color BEFORE the order goes to print.
 * Deliberately narrow (v1):
 *  - same product only (the variant must belong to the product they bought)
 *  - same price only - price-different swaps route to support, so no money
 *    ever moves in this flow
 *  - exactly ONE live Printify copy (replaced/split orders are a human job)
 *
 * Validation happens server-side BEFORE anything is committed anywhere, and
 * the Printify swap itself resolves the new variant against the Printify
 * order's own product (recreatePrintifyOrder refuses - original untouched -
 * when it can't). Order of operations mirrors the operator's proven
 * change_preproduction flow: Printify cancel+recreate first (fail-safe),
 * then the Shopify order edit so the receipt matches what will print, then
 * verify. Gated by the launch gate.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logAction } from '@/lib/audit';
import { createShopifyClient } from '@/lib/shopify';
import { createPrintifyClient } from '@/lib/printify';
import { recreatePrintifyOrder } from '@/lib/printify/relink';
import {
  getValidToken,
  consumeToken,
  releaseToken,
} from '@/lib/self-service/tokens';
import { manageFlowAllowed } from '@/lib/self-service/gate';
import { loadOrderStateForToken, reasonMessage } from '@/lib/self-service/orders';
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

/** "Blue Jean / L" and "L / Blue Jean" compare equal. */
const labelKey = (s: string) =>
  s
    .toLowerCase()
    .split('/')
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .sort()
    .join('|');

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
  // Same price only - no money moves in this flow.
  const linePrice = parseFloat(line.originalUnitPrice || '0');
  if (Math.abs(parseFloat(newVariant.price || '0') - linePrice) >= 0.005) {
    return NextResponse.json(
      {
        error:
          'That option has a different price, so we cannot swap it automatically. Email support@summitsoul.shop and we will sort it out.',
      },
      { status: 409 }
    );
  }

  const claimed = await consumeToken(token.id);
  if (!claimed) {
    return NextResponse.json(
      { error: 'This link has already been used. Request a new one to make another change.' },
      { status: 409 }
    );
  }

  try {
    // 1) Printify first: cancel + recreate the copy with the changed line. The
    //    replacement is created BEFORE the original is cancelled and every
    //    line must resolve against the Printify order's own catalog products,
    //    so an unresolvable swap aborts with the original order untouched.
    const desiredLines = state.shopifyOrder.lineItems.map((li) => ({
      sku: li.id === line.id ? newVariant.sku : li.sku,
      variantLabel: li.id === line.id ? newVariant.title : li.variantTitle,
      itemTitle: li.title,
      quantity: li.quantity,
    }));

    let result: Awaited<ReturnType<typeof recreatePrintifyOrder>>;
    try {
      result = await recreatePrintifyOrder({
        printifyOrderId: printifyCopy.id,
        shopifyOrderId: state.shopifyOrder.id,
        shopifyOrderName: token.shopifyOrderName,
        reason: 'ITEM_CHANGE',
        lineItems: desiredLines,
      });
    } catch (err) {
      result = {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
    if (!result.success || !result.newPrintifyOrderId) {
      if (result.inProduction) {
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
        error: result.error || 'recreate failed',
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
    const newPrintifyOrderId = result.newPrintifyOrderId;

    // 2) Shopify order edit so the receipt matches what will print. Same-price
    //    swap moves no money; the absorb discount only re-grants an original
    //    percentage discount code over the swapped-in line (Shopify re-adds
    //    the line at full catalog price).
    const origFull = state.shopifyOrder.lineItems.reduce(
      (s, li) => s + parseFloat(li.originalUnitPrice || '0') * li.quantity,
      0
    );
    const origPaid = state.shopifyOrder.lineItems.reduce(
      (s, li) =>
        s +
        parseFloat(li.discountedUnitPrice || li.originalUnitPrice || '0') *
          li.quantity,
      0
    );
    const pctRate =
      origFull > 0.01 ? Math.min(0.9, Math.max(0, 1 - origPaid / origFull)) : 0;
    const removedPaid =
      parseFloat(line.discountedUnitPrice || line.originalUnitPrice || '0') *
      line.quantity;
    const swappedInFull = parseFloat(newVariant.price || '0') * line.quantity;
    const grossUp = (net: number) => (pctRate > 0.001 ? net / (1 - pctRate) : net);
    const absorb = Math.max(
      0,
      Math.round((swappedInFull - grossUp(removedPaid)) * 100) / 100
    );

    let shopifyEditWarning: string | null = null;
    const editRes = await shopifyClient.editOrder({
      orderId: state.shopifyOrder.id,
      removeLineItemIds: [line.id],
      addItems: [
        {
          variantId: newVariant.id,
          quantity: line.quantity,
          discount: absorb > 0.001 ? absorb.toFixed(2) : undefined,
        },
      ],
      notifyCustomer: false,
      staffNote: 'Self-service size/color change before production.',
    });
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

    // 3) Verify: the replacement Printify order must actually contain the new
    //    variant. Compare labels as unordered token sets via each line's
    //    catalog product (same technique the resolver used).
    let verified = false;
    try {
      const printify = await createPrintifyClient();
      const created = printify ? await printify.getOrder(newPrintifyOrderId) : null;
      if (created && printify) {
        const want = labelKey(newVariant.title);
        for (const li of created.line_items) {
          const prod = await printify.getProduct(li.product_id);
          const v = prod?.variants.find((pv) => pv.id === li.variant_id);
          if (v && labelKey(v.title) === want) {
            verified = true;
            break;
          }
        }
      }
    } catch {
      verified = false;
    }
    if (!verified) {
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
    await sendSelfServiceChangeConfirmation({
      to: state.shopifyOrder.customerEmail || token.email,
      orderName: token.shopifyOrderName,
      heading: 'Size/color updated',
      changeSummary: `"${line.title}" on order ${token.shopifyOrderName} was changed from ${line.variantTitle || 'the original option'} to ${newVariant.title}. Same price - nothing to pay.`,
    }).catch((e) => console.error('[self-service/item-change] confirmation failed:', e));

    await logAction({
      threadId: null,
      userId: null,
      userName: 'Customer (self-service)',
      action: 'self_service_item_change',
      summary: `Customer self-changed "${line.title}" ${line.variantTitle} -> ${newVariant.title} on ${token.shopifyOrderName}${verified ? ' (verified)' : ' (VERIFY FAILED)'}${shopifyEditWarning ? ' [Shopify edit failed]' : ''}`,
      orderName: token.shopifyOrderName,
      metadata: {
        shopifyOrderId: state.shopifyOrder.id,
        newPrintifyOrderId,
        verified,
        shopifyEditWarning,
        requestIp: token.requestIp,
      },
    }).catch(() => undefined);

    await sendSelfServiceSupportNotice({
      orderName: token.shopifyOrderName,
      customerEmail: state.shopifyOrder.customerEmail || token.email,
      action: `Item changed (self-service): ${line.variantTitle} -> ${newVariant.title}${verified ? '' : ' - VERIFY FAILED, see alert'}`,
      printifyCancelled: true,
      total: `${state.shopifyOrder.totalPrice} ${state.shopifyOrder.totalPriceCurrency}`,
      requestIp: token.requestIp,
    }).catch(() => undefined);

    return NextResponse.json({
      ok: true,
      message: `Done - your ${line.title} is now ${newVariant.title}. Same price, nothing else changes. A confirmation email is on its way.`,
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
    await releaseToken(token.id);
    return NextResponse.json(
      { error: 'Something went wrong. Please try again or contact support@summitsoul.shop.' },
      { status: 500 }
    );
  }
}
