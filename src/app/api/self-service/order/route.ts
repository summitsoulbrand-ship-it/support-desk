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
import { createShopifyClient } from '@/lib/shopify';
import { getValidToken } from '@/lib/self-service/tokens';
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
  const canChangeItems =
    editable && !rerouted && state.printifyOrders.length === 1;
  const canChangeAddress = editable && !rerouted;

  // Same-price variant options per line item, only when changes are possible.
  const itemOptions: Record<
    string,
    { variantId: string; title: string }[]
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
      for (const li of state.shopifyOrder.lineItems) {
        const product = li.productId ? products.get(li.productId) : undefined;
        if (!product) continue;
        const linePrice = parseFloat(li.originalUnitPrice || '0');
        itemOptions[li.id] = product.variants
          .filter(
            (v) =>
              v.availableForSale &&
              v.id !== li.variantId &&
              Math.abs(parseFloat(v.price || '0') - linePrice) < 0.005
          )
          .map((v) => ({ variantId: v.id, title: v.title }));
      }
    }
  }

  const addr = state.shopifyOrder.shippingAddress;

  return NextResponse.json({
    orderName: token.shopifyOrderName,
    maskedEmail: maskEmail(state.shopifyOrder.customerEmail || ''),
    createdAt: state.shopifyOrder.createdAt,
    total: `${state.shopifyOrder.totalPrice} ${state.shopifyOrder.totalPriceCurrency}`,
    status,
    tracking,
    isEu: eu,
    deadlineCopy: editable ? PRODUCTION_DEADLINE_COPY : '',
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
