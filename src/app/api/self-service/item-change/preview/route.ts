/**
 * POST /api/self-service/item-change/preview  { token, lineItemId, newVariantId }
 *
 * Read-only price preview for a swap the customer is CONSIDERING. Runs the
 * edit through Shopify's calculator without committing, so the number shown
 * before the confirm button is the exact truth - tax recalculation and real
 * discount-code behavior included - not a local estimate. Never consumes the
 * token, changes nothing anywhere.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createShopifyClient } from '@/lib/shopify';
import { getValidToken } from '@/lib/self-service/tokens';
import { manageFlowAllowed } from '@/lib/self-service/gate';
import { computeSwapMoney } from '@/lib/self-service/money';
import { productionCutoff } from '@/lib/self-service/cutoff';

const bodySchema = z.object({
  token: z.string().min(1),
  lineItemId: z.string().min(1),
  newVariantId: z.string().min(1),
});

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
    return NextResponse.json({ error: 'This link is invalid or has expired.' }, { status: 400 });
  }

  const shopify = await createShopifyClient();
  if (!shopify) {
    return NextResponse.json({ error: 'Temporarily unavailable.' }, { status: 503 });
  }
  const order = await shopify.getOrderById(token.shopifyOrderId);
  if (!order) {
    return NextResponse.json({ error: 'Order not found.' }, { status: 404 });
  }
  const line = order.lineItems.find((li) => li.id === body.lineItemId);
  if (!line || !line.productId) {
    return NextResponse.json({ error: 'That item is not on this order.' }, { status: 400 });
  }
  const product = await shopify.getProductVariants(line.productId);
  const newVariant = product?.variants.find((v) => v.id === body.newVariantId);
  if (!newVariant || !newVariant.availableForSale) {
    return NextResponse.json({ error: 'That option is not available.' }, { status: 400 });
  }

  // The absorb keeps the customer's original pricing on the swapped line;
  // Shopify's calculator then tells us the exact resulting total.
  const swapLines = order.lineItems.map((li) => ({
    full: parseFloat(li.originalUnitPrice || '0'),
    paid: parseFloat(li.discountedUnitPrice || li.originalUnitPrice || '0'),
    quantity: li.quantity,
  }));
  const idx = order.lineItems.findIndex((li) => li.id === line.id);
  const money = computeSwapMoney(swapLines, swapLines[idx], parseFloat(newVariant.price || '0'));

  const calc = await shopify.previewOrderEditSwap({
    orderId: order.id,
    removeLineItemId: line.id,
    addVariantId: newVariant.id,
    quantity: line.quantity,
    discount: money.absorb > 0.001 ? money.absorb.toFixed(2) : undefined,
    currencyCode: order.totalPriceCurrency,
  });
  if (!calc.success || !calc.newTotalPrice) {
    return NextResponse.json(
      { error: 'Could not compute the exact price right now - try again in a moment.' },
      { status: 502 }
    );
  }
  const totalDelta =
    Math.round((parseFloat(calc.newTotalPrice) - parseFloat(order.totalPrice)) * 100) / 100;
  const kind = Math.abs(totalDelta) < 0.01 ? 'same' : totalDelta > 0 ? 'charge' : 'refund';

  // The real payment window a pricier swap would get right now.
  const cutoff = productionCutoff(new Date(order.createdAt));
  const deadline = Math.min(
    Date.now() + 6 * 60 * 60 * 1000,
    cutoff.getTime() - 45 * 60 * 1000
  );
  const windowMin = Math.max(0, Math.round((deadline - Date.now()) / 60000));
  const payWindowHuman =
    windowMin >= 90 ? `about ${Math.round(windowMin / 60)} hours` : `about ${windowMin} minutes`;

  return NextResponse.json({
    kind,
    amount: Math.abs(totalDelta).toFixed(2),
    currency: order.totalPriceCurrency,
    payWindowHuman,
    chargePossible: kind !== 'charge' || windowMin >= 15,
  });
}
