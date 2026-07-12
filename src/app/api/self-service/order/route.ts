/**
 * GET /api/self-service/order?token=...
 *
 * The manage-portal status view. Repeatable (never consumes the token): shows
 * where the order is, tracking links, the items, and which self-service
 * actions are currently possible. Reads Printify state from the webhook-fed
 * cache - fast and rate-limit friendly; every ACTION route re-checks live at
 * click time, so a stale view can never cause a wrong write.
 *
 * Gated by the manage-flow launch gate (404 until launched or previewed).
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { createShopifyClient } from '@/lib/shopify';
import { getValidToken } from '@/lib/self-service/tokens';
import { computeSwapMoney } from '@/lib/self-service/money';
import { productionCutoff } from '@/lib/self-service/cutoff';
import { manageFlowAllowed } from '@/lib/self-service/gate';
import {
  loadOrderStateForToken,
  derivePortalStatus,
  computeWithdrawEligibility,
  withdrawReasonMessage,
  reasonMessage,
  isEuOrder,
  maskEmail,
  hasActiveReroute,
  PRODUCTION_DEADLINE_COPY,
} from '@/lib/self-service/orders';

export async function GET(request: NextRequest) {
  if (!manageFlowAllowed(request)) {
    // Gate off (pre-launch or rollback): the page shows this message with a
    // "request a new link" path, which then mints a classic cancel/withdraw
    // link - the customer is never stranded.
    return NextResponse.json(
      { error: 'This link is no longer available. Please request a new one below.' },
      { status: 404 }
    );
  }

  const raw = new URL(request.url).searchParams.get('token') || '';
  const token = await getValidToken(raw);
  if (!token || token.purpose !== 'MANAGE') {
    return NextResponse.json(
      { error: 'This link is invalid or has expired. Please request a new one.' },
      { status: 400 }
    );
  }

  const state = await loadOrderStateForToken(token, { source: 'cache' });
  if (!state) {
    return NextResponse.json(
      { error: 'We could not load this order. Contact support@summitsoul.shop.' },
      { status: 404 }
    );
  }

  const { status, tracking } = derivePortalStatus(state);
  const eu = isEuOrder(state.shopifyOrder);
  const withdrawEligibility = computeWithdrawEligibility(state.shopifyOrder);

  // What can the customer DO right now?
  const editable = status === 'editable';
  const canCancel = eu ? withdrawEligibility.eligible : editable;
  const cancelBlockedMessage = canCancel
    ? ''
    : eu
      ? withdrawReasonMessage(withdrawEligibility.reason)
      : reasonMessage(state.eligibility.reason);
  // Item changes need exactly one live Printify copy (a replaced/split order
  // is a human job); address changes work for any editable order. Manually
  // rerouted orders are a human job for both (a rebuild would lose the
  // regional print provider).
  const rerouted = editable
    ? await hasActiveReroute(state.shopifyOrder.id)
    : false;
  // A swap already parked on a payment link blocks further item changes.
  const pendingChange = await prisma.pendingItemChange.findFirst({
    where: { shopifyOrderId: state.shopifyOrder.id, status: 'AWAITING_PAYMENT' },
  });
  const canChangeItems =
    editable && !rerouted && !pendingChange && state.printifyOrders.length === 1;
  const canChangeAddress = editable && !rerouted;

  // Variant options per line item (all prices - the customer sees the
  // difference and how it settles BEFORE confirming anything).
  const itemOptions: Record<
    string,
    { variantId: string; title: string; kind: 'same' | 'refund' | 'charge'; amount: string }[]
  > = {};
  if (canChangeItems) {
    const shopify = await createShopifyClient();
    if (shopify) {
      const productIds = [
        ...new Set(
          state.shopifyOrder.lineItems
            .map((li) => li.productId)
            .filter(Boolean) as string[]
        ),
      ];
      const products = new Map<
        string,
        NonNullable<Awaited<ReturnType<typeof shopify.getProductVariants>>>
      >();
      const fetched = await Promise.all(
        productIds.map((pid) => shopify.getProductVariants(pid))
      );
      productIds.forEach((pid, i) => {
        const product = fetched[i];
        if (product) products.set(pid, product);
      });
      const swapLines = state.shopifyOrder.lineItems.map((li) => ({
        full: parseFloat(li.originalUnitPrice || '0'),
        paid: parseFloat(li.discountedUnitPrice || li.originalUnitPrice || '0'),
        quantity: li.quantity,
      }));
      state.shopifyOrder.lineItems.forEach((li, idx) => {
        const product = li.productId ? products.get(li.productId) : undefined;
        if (!product) return;
        itemOptions[li.id] = product.variants
          .filter((v) => v.availableForSale && v.id !== li.variantId)
          .map((v) => {
            const money = computeSwapMoney(
              swapLines,
              swapLines[idx],
              parseFloat(v.price || '0')
            );
            return {
              variantId: v.id,
              title: v.title,
              kind: money.kind,
              amount: money.amount.toFixed(2),
            };
          });
      });
    }
  }

  const addr = state.shopifyOrder.shippingAddress;
  const o = state.shopifyOrder;
  const cutoffAt = editable
    ? productionCutoff(new Date(o.createdAt)).toISOString()
    : null;

  return NextResponse.json({
    orderName: token.shopifyOrderName,
    maskedEmail: maskEmail(o.customerEmail || ''),
    createdAt: o.createdAt,
    total: `${o.totalPrice} ${o.totalPriceCurrency}`,
    status,
    tracking,
    isEu: eu,
    deadlineCopy: editable ? PRODUCTION_DEADLINE_COPY : '',
    cutoffAt,
    currency: o.totalPriceCurrency,
    payment: {
      subtotal: o.subtotalPrice,
      shipping: o.totalShippingPrice,
      tax: o.totalTax,
      discounts: o.totalDiscounts || '0',
      discountCodes: o.discountCodes || [],
      total: o.totalPrice,
      refunded: o.totalRefunded || '0',
      outstanding: o.totalOutstanding || '0',
      financialStatus: o.financialStatus || '',
    },
    pendingChange: pendingChange
      ? {
          itemTitle: pendingChange.itemTitle,
          oldVariantTitle: pendingChange.oldVariantTitle,
          newVariantTitle: pendingChange.newVariantTitle,
          amount: pendingChange.chargeAmount,
          payBy: pendingChange.payBy.toISOString(),
        }
      : null,
    canCancel,
    cancelBlockedMessage,
    canChangeItems,
    canChangeAddress,
    items: state.shopifyOrder.lineItems.map((li) => ({
      lineItemId: li.id,
      title: li.title,
      variantTitle: li.variantTitle || '',
      quantity: li.quantity,
      imageUrl: li.variantImageUrl || li.imageUrl || null,
      options: itemOptions[li.id] || [],
    })),
    shippingAddress: addr
      ? {
          firstName: addr.firstName || '',
          lastName: addr.lastName || '',
          address1: addr.address1 || '',
          address2: addr.address2 || '',
          city: addr.city || '',
          zip: addr.zip || '',
          provinceCode: addr.provinceCode || '',
          province: addr.province || '',
          country: addr.country || '',
          countryCode: addr.countryCode || '',
          phone: addr.phone || '',
        }
      : null,
  });
}
