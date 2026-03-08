/**
 * Combine Printify Orders API
 * Combines two orders into one when a customer orders multiple times
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { createPrintifyClient, PrintifyClient } from '@/lib/printify';
import { createShopifyClient } from '@/lib/shopify';
import type { PrintifyOrder, PrintifyAddress } from '@/lib/printify';

const combineOrdersSchema = z.object({
  orderNumber1: z.string().min(1, 'First order number is required'),
  orderNumber2: z.string().min(1, 'Second order number is required'),
});

/**
 * Search for Printify orders by order number or customer name
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'CHANGE_STATUS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('q');

    if (!query || query.length < 2) {
      return NextResponse.json({ orders: [] });
    }

    const printifyClient = await createPrintifyClient();
    if (!printifyClient) {
      return NextResponse.json(
        { error: 'Printify not configured' },
        { status: 400 }
      );
    }

    // Search through cached orders first (faster)
    const normalizedQuery = query.replace(/^#/, '').trim().toLowerCase();

    const cachedOrders = await prisma.printifyOrderCache.findMany({
      where: {
        OR: [
          { externalId: { contains: normalizedQuery, mode: 'insensitive' } },
          { label: { contains: normalizedQuery, mode: 'insensitive' } },
          { metadataShopOrderId: { contains: normalizedQuery, mode: 'insensitive' } },
          { metadataShopOrderLabel: { contains: normalizedQuery, mode: 'insensitive' } },
        ],
        // Only include orders that aren't cancelled
        status: { not: 'cancelled' },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    const orders = cachedOrders.map((cached) => {
      const data = cached.data as unknown as PrintifyOrder;
      return {
        id: cached.id,
        printifyId: data.id,
        externalId: cached.externalId || data.external_id,
        label: cached.label || data.label,
        status: cached.status || data.status,
        customerName: `${data.address_to.first_name || ''} ${data.address_to.last_name || ''}`.trim(),
        customerEmail: data.address_to.email,
        createdAt: cached.createdAt.toISOString(),
        itemCount: data.line_items.reduce((sum, li) => sum + li.quantity, 0),
        canCancel: PrintifyClient.canCancelOrder(data),
        address: data.address_to,
      };
    });

    // If no cached results, search Printify directly
    if (orders.length === 0) {
      const printifyOrder = await printifyClient.findByExternalId(query);
      if (printifyOrder) {
        orders.push({
          id: printifyOrder.id,
          printifyId: printifyOrder.id,
          externalId: printifyOrder.external_id,
          label: printifyOrder.label,
          status: printifyOrder.status,
          customerName: `${printifyOrder.address_to.first_name || ''} ${printifyOrder.address_to.last_name || ''}`.trim(),
          customerEmail: printifyOrder.address_to.email,
          createdAt: printifyOrder.created_at,
          itemCount: printifyOrder.line_items.reduce((sum, li) => sum + li.quantity, 0),
          canCancel: PrintifyClient.canCancelOrder(printifyOrder),
          address: printifyOrder.address_to,
        });
      }
    }

    return NextResponse.json({ orders });
  } catch (err) {
    console.error('Error searching orders:', err);
    return NextResponse.json(
      { error: 'Failed to search orders' },
      { status: 500 }
    );
  }
}

/**
 * Combine two Printify orders into one
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'CHANGE_STATUS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = combineOrdersSchema.parse(await request.json());

    const printifyClient = await createPrintifyClient();
    if (!printifyClient) {
      return NextResponse.json(
        { error: 'Printify not configured' },
        { status: 400 }
      );
    }

    // Helper to find order - try by external ID first, then by Printify ID
    const findOrder = async (orderRef: string): Promise<PrintifyOrder | null> => {
      // First try by external ID (order number)
      const byExternalId = await printifyClient.findByExternalId(orderRef);
      if (byExternalId) return byExternalId;

      // If it looks like a Printify ID (24-char hex), try direct lookup
      if (/^[a-f0-9]{24}$/i.test(orderRef)) {
        return printifyClient.getOrder(orderRef);
      }

      return null;
    };

    // Find both orders
    const order1 = await findOrder(body.orderNumber1);
    const order2 = await findOrder(body.orderNumber2);

    if (!order1) {
      return NextResponse.json(
        { error: `Order ${body.orderNumber1} not found in Printify` },
        { status: 404 }
      );
    }

    if (!order2) {
      return NextResponse.json(
        { error: `Order ${body.orderNumber2} not found in Printify` },
        { status: 404 }
      );
    }

    // Validate that the orders are not the same
    if (order1.id === order2.id) {
      return NextResponse.json(
        { error: 'Cannot combine an order with itself' },
        { status: 400 }
      );
    }

    // Validate shipping addresses match
    const addressMismatch = validateAddressesMatch(order1.address_to, order2.address_to);
    if (addressMismatch) {
      return NextResponse.json(
        { error: `Shipping addresses do not match: ${addressMismatch}` },
        { status: 400 }
      );
    }

    // Check if both orders can be cancelled (not in production)
    if (!PrintifyClient.canCancelOrder(order1)) {
      return NextResponse.json(
        { error: `Order ${body.orderNumber1} is already in production and cannot be cancelled` },
        { status: 400 }
      );
    }

    if (!PrintifyClient.canCancelOrder(order2)) {
      return NextResponse.json(
        { error: `Order ${body.orderNumber2} is already in production and cannot be cancelled` },
        { status: 400 }
      );
    }

    // Determine which order was created first (use its label for the new order)
    const order1Date = new Date(order1.created_at);
    const order2Date = new Date(order2.created_at);
    const primaryOrder = order1Date <= order2Date ? order1 : order2;
    const secondaryOrder = order1Date <= order2Date ? order2 : order1;

    // Use the external_id/label from the first order
    const newExternalId = primaryOrder.external_id || primaryOrder.label || body.orderNumber1;
    const newLabel = primaryOrder.label || primaryOrder.external_id || body.orderNumber1;

    // Combine line items - collect SKUs from both orders
    const combinedSkus: { sku: string; quantity: number }[] = [];

    for (const lineItem of [...primaryOrder.line_items, ...secondaryOrder.line_items]) {
      const sku = lineItem.metadata?.sku;
      if (!sku) {
        return NextResponse.json(
          { error: `Line item in order ${lineItem.product_id} is missing SKU. Cannot combine orders.` },
          { status: 400 }
        );
      }

      const existing = combinedSkus.find((item) => item.sku === sku);
      if (existing) {
        existing.quantity += lineItem.quantity;
      } else {
        combinedSkus.push({ sku, quantity: lineItem.quantity });
      }
    }

    // Create the new combined order
    const createResult = await printifyClient.createOrderWithSkus({
      externalId: newExternalId,
      label: newLabel,
      addressTo: primaryOrder.address_to,
      lineItems: combinedSkus,
    });

    if (!createResult.success) {
      return NextResponse.json(
        { error: `Failed to create combined order: ${createResult.error}` },
        { status: 500 }
      );
    }

    // Cancel both original orders
    const cancelResult1 = await printifyClient.cancelOrder(order1.id);
    if (!cancelResult1.success) {
      console.error(`Warning: Failed to cancel order ${order1.id}:`, cancelResult1.error);
      // Continue anyway - the combined order was created
    }

    const cancelResult2 = await printifyClient.cancelOrder(order2.id);
    if (!cancelResult2.success) {
      console.error(`Warning: Failed to cancel order ${order2.id}:`, cancelResult2.error);
      // Continue anyway - the combined order was created
    }

    // Find the newly created order to get its ID
    const newOrder = await printifyClient.findByExternalId(newExternalId);

    // Update cache - mark old orders as cancelled
    await prisma.printifyOrderCache.updateMany({
      where: { id: { in: [order1.id, order2.id] } },
      data: { status: 'cancelled' },
    });

    // Release the hold on the primary Shopify order (the first one created)
    // The external_id/label is the Shopify order number (e.g., "12309" or "#12309")
    const shopifyClient = await createShopifyClient();
    let holdReleased = false;
    let holdReleaseError: string | undefined;

    if (shopifyClient && newExternalId) {
      // Try to find the Shopify order ID from the order number
      const shopifyOrderNumber = newExternalId.replace(/^#/, '');

      // Look up the Shopify order in our customer link cache
      const cachedOrder = await prisma.customerLink.findFirst({
        where: {
          shopifyData: {
            path: ['orders'],
            array_contains: [{ name: `#${shopifyOrderNumber}` }],
          },
        },
      });

      // If not in cache, try to get it directly from the order link
      const orderLink = await prisma.orderLink.findFirst({
        where: {
          OR: [
            { shopifyOrderNumber: shopifyOrderNumber },
            { shopifyOrderNumber: `#${shopifyOrderNumber}` },
          ],
        },
      });

      const shopifyOrderId = orderLink?.shopifyOrderId;

      if (shopifyOrderId) {
        const releaseResult = await shopifyClient.releaseOrderHold(shopifyOrderId);
        holdReleased = releaseResult.success;
        if (!releaseResult.success && releaseResult.errors) {
          holdReleaseError = releaseResult.errors.join(', ');
          console.error('Warning: Failed to release Shopify order hold:', holdReleaseError);
        }
      } else {
        console.log(`Note: Could not find Shopify order ID for ${newExternalId} to release hold`);
      }
    }

    return NextResponse.json({
      success: true,
      combinedOrderLabel: newLabel,
      combinedOrderId: newOrder?.id,
      cancelledOrders: [
        { id: order1.id, label: order1.label || order1.external_id },
        { id: order2.id, label: order2.label || order2.external_id },
      ],
      itemCount: combinedSkus.reduce((sum, item) => sum + item.quantity, 0),
      holdReleased,
      holdReleaseError,
    });
  } catch (err) {
    console.error('Error combining orders:', err);
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request', details: err.issues },
        { status: 400 }
      );
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Validate that two addresses match
 * Returns null if they match, or an error message describing the mismatch
 */
function validateAddressesMatch(
  addr1: PrintifyAddress,
  addr2: PrintifyAddress
): string | null {
  const normalize = (value?: string) => (value || '').toLowerCase().trim();

  const checks: { field: string; val1: string; val2: string }[] = [
    { field: 'address line 1', val1: normalize(addr1.address1), val2: normalize(addr2.address1) },
    { field: 'city', val1: normalize(addr1.city), val2: normalize(addr2.city) },
    { field: 'zip/postal code', val1: normalize(addr1.zip), val2: normalize(addr2.zip) },
    { field: 'country', val1: normalize(addr1.country), val2: normalize(addr2.country) },
  ];

  for (const check of checks) {
    if (check.val1 !== check.val2) {
      return `${check.field} differs: "${check.val1 || '(empty)'}" vs "${check.val2 || '(empty)'}"`;
    }
  }

  // Check region/state (if both are present)
  const region1 = normalize(addr1.region);
  const region2 = normalize(addr2.region);
  if (region1 && region2 && region1 !== region2) {
    return `state/region differs: "${region1}" vs "${region2}"`;
  }

  return null;
}
