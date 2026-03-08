/**
 * Re-route Order API
 * Cancels an order and recreates it with international print provider variants
 * Fallback order:
 * 1. Printify Choice (auto-routes globally)
 * 2. Regional provider based on destination country
 * 3. Create new product as Printify Choice (draft) - requires manual publish
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { PrintifyClient, type PrintifyOrder } from '@/lib/printify';
import { PrintifyConfig } from '@/lib/printify/types';
import { decryptJson } from '@/lib/encryption';

interface RerouteLineItem {
  sku: string;
  quantity: number;
  originalTitle: string;
  provider: string;
  method: 'printify_choice' | 'regional' | 'created' | 'original';
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'CHANGE_STATUS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const { orderId } = body;

    if (!orderId) {
      return NextResponse.json({ error: 'Order ID is required' }, { status: 400 });
    }

    // Get Printify client
    const settings = await prisma.integrationSettings.findUnique({
      where: { type: 'PRINTIFY' },
    });

    if (!settings || !settings.enabled) {
      return NextResponse.json(
        { error: 'Printify integration not configured' },
        { status: 400 }
      );
    }

    const config = decryptJson<PrintifyConfig>(settings.encryptedData);
    const client = new PrintifyClient(config);

    // Fetch the order from cache
    const cachedOrder = await prisma.printifyOrderCache.findUnique({
      where: { id: orderId },
    });

    if (!cachedOrder) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    const orderData = cachedOrder.data as unknown as PrintifyOrder;
    const destinationCountry = orderData.address_to?.country || 'DEFAULT';

    // Check if order can be cancelled
    if (!PrintifyClient.canCancelOrder(orderData)) {
      return NextResponse.json(
        { error: 'Order cannot be rerouted - it may already be in production' },
        { status: 400 }
      );
    }

    // Step 1: Find international variants for each line item
    const newLineItems: RerouteLineItem[] = [];
    const failedItems: string[] = [];
    const createdProducts: { title: string; productId: string }[] = [];

    for (const li of orderData.line_items) {
      const itemTitle = li.metadata?.title || li.product_id;

      try {
        // Get the original product
        const originalProduct = await client.getProduct(li.product_id);

        // Try to find an international variant (Printify Choice or regional)
        const internationalMatch = await client.findInternationalVariant(
          originalProduct,
          li.variant_id,
          destinationCountry
        );

        if (internationalMatch) {
          newLineItems.push({
            sku: internationalMatch.sku,
            quantity: li.quantity,
            originalTitle: itemTitle,
            provider: internationalMatch.provider,
            method: internationalMatch.method,
          });
        } else {
          // No existing variant found - try to create a new Printify Choice product
          console.log(`No international variant found for ${itemTitle}, attempting to create product...`);

          // Get available print providers for this blueprint
          const blueprintProviders = await client.getBlueprintPrintProviders(
            originalProduct.blueprint_id
          );

          const createResult = await client.duplicateProductAsPrintifyChoice(
            originalProduct,
            blueprintProviders
          );

          if (createResult.success && createResult.productId) {
            createdProducts.push({
              title: `${originalProduct.title} (Printify Choice) Global`,
              productId: createResult.productId,
            });

            // Fetch the newly created product to get variant SKU
            const newProduct = await client.getProduct(createResult.productId);
            const originalVariant = originalProduct.variants.find(
              (v) => v.id === li.variant_id
            );

            if (originalVariant) {
              // Find matching variant in new product by title
              const normalizedTitle = originalVariant.title.toLowerCase();
              const matchingVariant = newProduct.variants.find(
                (v) => v.is_enabled && v.title.toLowerCase() === normalizedTitle
              );

              if (matchingVariant) {
                newLineItems.push({
                  sku: matchingVariant.sku,
                  quantity: li.quantity,
                  originalTitle: itemTitle,
                  provider: 'Printify Choice (New Product)',
                  method: 'created',
                });
              } else {
                // Variant not found in new product, use original SKU as fallback
                if (li.sku) {
                  newLineItems.push({
                    sku: li.sku,
                    quantity: li.quantity,
                    originalTitle: itemTitle,
                    provider: 'Original (variant mismatch)',
                    method: 'original',
                  });
                } else {
                  failedItems.push(`${itemTitle} - variant not found in new product`);
                }
              }
            } else {
              failedItems.push(`${itemTitle} - original variant not found`);
            }
          } else {
            // Product creation failed, use original SKU as fallback
            if (li.sku) {
              newLineItems.push({
                sku: li.sku,
                quantity: li.quantity,
                originalTitle: itemTitle,
                provider: 'Original (no alternative)',
                method: 'original',
              });
            } else {
              failedItems.push(`${itemTitle} - ${createResult.error || 'could not create product'}`);
            }
          }
        }
      } catch (productError) {
        console.error(`Failed to process ${itemTitle}:`, productError);
        // Fall back to original SKU
        if (li.sku) {
          newLineItems.push({
            sku: li.sku,
            quantity: li.quantity,
            originalTitle: itemTitle,
            provider: 'Original (error)',
            method: 'original',
          });
        } else {
          failedItems.push(`${itemTitle} - ${productError instanceof Error ? productError.message : 'unknown error'}`);
        }
      }
    }

    // If we have no valid line items, don't proceed
    if (newLineItems.length === 0) {
      return NextResponse.json(
        {
          error: 'Could not find or create any valid line items',
          failedItems,
          createdProducts: createdProducts.map((p) => `${p.title} (ID: ${p.productId})`),
        },
        { status: 400 }
      );
    }

    // Step 2: Cancel the original order
    const cancelResult = await client.cancelOrder(orderData.id);
    if (!cancelResult.success) {
      return NextResponse.json(
        { error: `Failed to cancel the original order: ${cancelResult.error}` },
        { status: 500 }
      );
    }

    // Step 3: Create a new order with international variants
    let newOrder;
    try {
      newOrder = await client.createOrder({
        external_id: orderData.external_id,
        label: orderData.label,
        shipping_method: 1,
        address_to: orderData.address_to,
        line_items: newLineItems.map((item) => ({
          sku: item.sku,
          quantity: item.quantity,
        })),
        send_shipping_notification: true,
      });
    } catch (createError) {
      console.error('Failed to create new order:', createError);
      return NextResponse.json(
        {
          error: 'Original order cancelled but failed to create new order. Manual intervention required.',
          cancelledOrderId: orderData.id,
          orderDetails: {
            label: orderData.label,
            external_id: orderData.external_id,
            customer: `${orderData.address_to.first_name} ${orderData.address_to.last_name}`,
            country: destinationCountry,
            lineItems: newLineItems,
          },
          createdProducts: createdProducts.map((p) => `${p.title} (ID: ${p.productId})`),
        },
        { status: 500 }
      );
    }

    // Step 4: Clean up cache
    try {
      await prisma.printifyOrderCache.delete({
        where: { id: orderId },
      });
    } catch (cacheError) {
      console.error('Failed to update order cache:', cacheError);
    }

    // Build response
    const routingDetails = newLineItems.map(
      (item) => `${item.originalTitle}: ${item.provider}`
    );

    const reroutedCount = newLineItems.filter((i) => i.method !== 'original').length;
    const originalCount = newLineItems.filter((i) => i.method === 'original').length;

    let message = `Order rerouted: ${reroutedCount} item(s) to international providers`;
    if (originalCount > 0) {
      message += `, ${originalCount} kept original provider`;
    }
    if (createdProducts.length > 0) {
      message += `. ${createdProducts.length} new product(s) created in draft`;
    }

    return NextResponse.json({
      success: true,
      message,
      originalOrderId: orderData.id,
      newOrderId: newOrder.id,
      newOrderLabel: newOrder.label,
      destinationCountry,
      routing: routingDetails,
      stats: {
        total: newLineItems.length,
        rerouted: reroutedCount,
        original: originalCount,
        failed: failedItems.length,
      },
      createdProducts: createdProducts.map((p) => ({
        title: p.title,
        productId: p.productId,
        note: 'Product created in draft status - publish when ready',
      })),
      failedItems,
    });
  } catch (err) {
    console.error('Error rerouting order:', err);
    return NextResponse.json(
      { error: 'Failed to reroute order', details: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
