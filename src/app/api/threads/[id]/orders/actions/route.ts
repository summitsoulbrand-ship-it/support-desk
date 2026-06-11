/**
 * Order actions API - Shopify/Printify actions for a thread
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { createShopifyClient } from '@/lib/shopify';
import { createPrintifyClient, PrintifyClient } from '@/lib/printify';
import { syncPrintifyOrders } from '@/lib/printify/sync';
import { recreatePrintifyOrder } from '@/lib/printify/relink';
import type { PrintifyOrder } from '@/lib/printify/types';

type RouteContext = {
  params: Promise<{ id: string }>;
};

// Helper to convert null values to undefined for Shopify API compatibility
function nullToUndefined<T extends Record<string, unknown>>(
  obj: T
): { [K in keyof T]: Exclude<T[K], null> | undefined } {
  const result = {} as { [K in keyof T]: Exclude<T[K], null> | undefined };
  for (const key in obj) {
    result[key] = obj[key] === null ? undefined : (obj[key] as Exclude<T[typeof key], null>);
  }
  return result;
}

const optionalString = z.string().nullable().optional();

const addressSchema = z.object({
  name: optionalString,
  firstName: optionalString,
  lastName: optionalString,
  company: optionalString,
  address1: optionalString,
  address2: optionalString,
  city: optionalString,
  province: optionalString,
  provinceCode: optionalString,
  country: optionalString,
  countryCode: optionalString,
  zip: optionalString,
  phone: optionalString,
});

const printifyAddressSchema = z.object({
  first_name: optionalString,
  last_name: optionalString,
  email: optionalString,
  phone: optionalString,
  country: optionalString,
  region: optionalString,
  address1: optionalString,
  address2: optionalString,
  city: optionalString,
  zip: optionalString,
});

const actionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('update_shipping'),
    orderId: z.string(),
    shopifyAddress: addressSchema,
    printifyOrderId: z.string().optional(),
    printifyAddress: printifyAddressSchema.optional(),
  }),
  z.object({
    action: z.literal('cancel_shopify'),
    orderId: z.string(),
    reason: z
      .enum(['CUSTOMER', 'INVENTORY', 'FRAUD', 'DECLINED', 'OTHER', 'STAFF'])
      .optional(),
    refundMethod: z.enum(['ORIGINAL', 'STORE_CREDIT']).optional(),
    staffNote: z.string().optional(),
    notify: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('cancel_printify'),
    printifyOrderId: z.string(),
  }),
  z.object({
    action: z.literal('cancel_both'),
    orderId: z.string(),
    printifyOrderId: z.string().optional(),
    reason: z
      .enum(['CUSTOMER', 'INVENTORY', 'FRAUD', 'DECLINED', 'OTHER', 'STAFF'])
      .optional(),
    refundMethod: z.enum(['ORIGINAL', 'STORE_CREDIT']).optional(),
    staffNote: z.string().optional(),
    notify: z.boolean().optional(),
    // Cancel + refund Shopify even when the Printify order is already in
    // production and cannot be cancelled (requires explicit confirmation)
    force: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('confirm_printify_address'),
    orderId: z.string(),
    printifyOrderId: z.string().optional(),
  }),
  z.object({
    action: z.literal('create_replacement'),
    orderId: z.string(),
    lineItems: z.array(
      z.object({
        variantId: z.string(),
        quantity: z.number().int().positive(),
        requiresShipping: z.boolean().optional(),
      })
    ),
    reason: z.string().optional(),
    note: z.string().optional(),
    tags: z.array(z.string()).optional(),
    discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']).optional(),
    discountValue: z.string().optional(),
    customerId: z.string().optional(),
    email: z.string().optional(),
    shippingAddress: addressSchema.optional(),
    billingAddress: addressSchema.optional(),
    shippingLine: z
      .object({
        title: z.string(),
        price: z.string(),
        currencyCode: z.string().optional(),
      })
      .optional(),
    taxExempt: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('refund'),
    orderId: z.string(),
    amount: z.string().optional(),
    reason: z.string().optional(),
    refundShipping: z.boolean().optional(),
    shippingAmount: z.string().optional(),
    notify: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('discount_adjustment'),
    orderId: z.string(),
    // A discount code to honor (looked up in Shopify) ...
    code: z.string().optional(),
    // ... or a manual percentage (0-100) if no code
    percentage: z.number().optional(),
    notify: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('create_draft_order'),
    customerId: z.string().optional(),
    email: z.string().optional(),
    lineItems: z.array(
      z.object({
        variantId: z.string(),
        quantity: z.number().int().positive(),
      })
    ),
    shippingAddress: addressSchema.optional(),
    discount: z
      .object({
        value: z.number(),
        type: z.enum(['FIXED_AMOUNT', 'PERCENTAGE']),
        title: z.string().optional(),
      })
      .optional(),
    shippingPrice: z.string().optional(),
    shippingTitle: z.string().optional(),
    note: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  z.object({
    action: z.literal('edit_order'),
    orderId: z.string(),
    addItems: z
      .array(
        z.object({
          variantId: z.string(),
          quantity: z.number().int().positive(),
          discount: z.string().optional(), // Fixed amount discount
        })
      )
      .optional(),
    removeLineItemIds: z.array(z.string()).optional(),
    updateQuantities: z
      .array(
        z.object({
          lineItemId: z.string(),
          quantity: z.number().int().positive(),
        })
      )
      .optional(),
    notifyCustomer: z.boolean().optional(),
    staffNote: z.string().optional(),
  }),
]);

function isPrintifyInProduction(order: PrintifyOrder): boolean {
  const statuses = order.line_items.map((li) => li.status);
  const shippedStatuses = new Set([
    'shipping',
    'fulfilled',
    'delivered',
    'partially-fulfilled',
  ]);
  return (
    statuses.some((status) => shippedStatuses.has(status)) ||
    shippedStatuses.has(order.status)
  );
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'CHANGE_STATUS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id: threadId } = await context.params;
    const body = actionSchema.parse(await request.json());

    // After a customer-facing action, retire the pre-action draft - the
    // triage worker regenerates one that confirms what was just done
    // (lastAction* feeds the prompt's Recent Action block).
    const staleDraftAfterAction = () =>
      prisma.aiDraft
        .updateMany({
          where: { threadId, status: { in: ['READY', 'AWAITING_ACTION', 'FAILED'] } },
          data: { status: 'STALE' },
        })
        .catch(() => undefined);

    if (body.action === 'update_shipping') {
      const shopifyClient = await createShopifyClient();
      if (!shopifyClient) {
        return NextResponse.json(
          { error: 'Shopify not configured' },
          { status: 400 }
        );
      }

      const shopifyResult = await shopifyClient.updateOrderShippingAddress(
        body.orderId,
        nullToUndefined(body.shopifyAddress)
      );

      let printifyUpdated = false;
      let printifyMessage: string | null = null;
      let printifyDeepLink: string | null = null;
      let newPrintifyOrderId: string | null = null;

      if (body.printifyOrderId) {
        // Printify has no address-update API. If the order hasn't entered
        // production we cancel + recreate it with the new address and relink
        // tracking back to the original Shopify order.
        const a = body.printifyAddress
          ? nullToUndefined(body.printifyAddress)
          : undefined;
        const s = nullToUndefined(body.shopifyAddress);
        const newAddress = {
          first_name: a?.first_name ?? s.firstName,
          last_name: a?.last_name ?? s.lastName,
          email: a?.email,
          phone: a?.phone ?? s.phone,
          country: a?.country ?? s.countryCode,
          region: a?.region ?? s.provinceCode,
          address1: a?.address1 ?? s.address1,
          address2: a?.address2 ?? s.address2,
          city: a?.city ?? s.city,
          zip: a?.zip ?? s.zip,
        };

        const order = await shopifyClient.getOrderById(body.orderId);

        // Never let a Printify-side crash swallow the Shopify result - the
        // response must always report what happened on each side.
        let result: Awaited<ReturnType<typeof recreatePrintifyOrder>>;
        try {
          result = await recreatePrintifyOrder({
            printifyOrderId: body.printifyOrderId,
            shopifyOrderId: body.orderId,
            shopifyOrderName: order?.name,
            reason: 'ADDRESS_CHANGE',
            newAddress,
          });
        } catch (err) {
          result = {
            success: false,
            error: `Printify recreate crashed: ${
              err instanceof Error ? err.message : 'unknown error'
            }. Check Printify for the order state before retrying.`,
          };
        }

        if (result.success) {
          printifyUpdated = true;
          newPrintifyOrderId = result.newPrintifyOrderId || null;
          printifyMessage =
            'Printify order was cancelled and recreated with the new address. ' +
            'Tracking will be pushed back onto the original Shopify order when it ships.';
        } else if (result.inProduction) {
          printifyMessage =
            'Printify order is already in production - the address cannot be changed there anymore. ' +
            'Contact Printify support or handle via replacement if the package will misdeliver.';
          printifyDeepLink = `https://printify.com/app/orders/${body.printifyOrderId}`;
        } else {
          printifyMessage = result.error || 'Printify update failed';
        }
      }

      if (shopifyResult.success || printifyUpdated) {
        await prisma.thread.update({
          where: { id: threadId },
          data: {
            lastActionType: 'shipping_address_updated',
            lastActionAt: new Date(),
            lastActionData: {
              orderId: body.orderId,
              printifyOrderId: body.printifyOrderId || null,
              newPrintifyOrderId,
              printifyUpdated,
            },
          },
        });
      await staleDraftAfterAction();
      }

      return NextResponse.json({
        shopify: shopifyResult,
        printifyUpdated,
        printifyMessage,
        printifyDeepLink,
        newPrintifyOrderId,
      });
    }

    if (body.action === 'cancel_both') {
      const shopifyClient = await createShopifyClient();
      if (!shopifyClient) {
        return NextResponse.json(
          { error: 'Shopify not configured' },
          { status: 400 }
        );
      }

      const printify: {
        attempted: boolean;
        success: boolean;
        inProduction?: boolean;
        message?: string;
        deepLink?: string;
      } = { attempted: false, success: false };

      if (body.printifyOrderId) {
        printify.attempted = true;
        const printifyClient = await createPrintifyClient();
        if (!printifyClient) {
          printify.message = 'Printify not configured';
        } else {
          const order =
            (await printifyClient.getOrder(body.printifyOrderId)) ||
            ((await prisma.printifyOrderCache.findUnique({
              where: { id: body.printifyOrderId },
            }))?.data as unknown as PrintifyOrder | undefined);

          if (!order) {
            printify.message = 'Printify order not found';
          } else if (!PrintifyClient.canCancelOrder(order)) {
            printify.inProduction = true;
            printify.message = 'Printify order is already in production and cannot be cancelled';
            printify.deepLink = `https://printify.com/app/orders/${body.printifyOrderId}`;

            if (!body.force) {
              // Let the UI ask: "cancel + refund Shopify anyway?"
              return NextResponse.json(
                { needsForce: true, printify },
                { status: 409 }
              );
            }
          } else {
            const result = await printifyClient.cancelOrder(body.printifyOrderId);
            printify.success = result.success;
            if (!result.success) {
              printify.message = result.error || 'Printify cancel failed';
              if (!body.force) {
                return NextResponse.json(
                  { needsForce: true, printify },
                  { status: 409 }
                );
              }
            } else {
              await prisma.printifyOrderCache.update({
                where: { id: body.printifyOrderId },
                data: { status: 'cancelled', lastSyncedAt: new Date() },
              }).catch(() => undefined);
            }
          }
        }
      }

      const shopify = await shopifyClient.cancelOrder(
        body.orderId,
        body.reason || 'CUSTOMER',
        body.refundMethod || 'ORIGINAL',
        body.staffNote,
        body.notify ?? true
      );

      if (shopify.success) {
        await prisma.thread.update({
          where: { id: threadId },
          data: {
            lastActionType: 'order_cancelled_both',
            lastActionAt: new Date(),
            lastActionData: {
              orderId: body.orderId,
              printifyOrderId: body.printifyOrderId || null,
              printifyCancelled: printify.success,
              refund: true,
            },
          },
        });
      await staleDraftAfterAction();
      }

      return NextResponse.json({
        success: shopify.success,
        shopify,
        printify,
      });
    }

    if (body.action === 'cancel_shopify') {
      const shopifyClient = await createShopifyClient();
      if (!shopifyClient) {
        return NextResponse.json(
          { error: 'Shopify not configured' },
          { status: 400 }
        );
      }

      const result = await shopifyClient.cancelOrder(
        body.orderId,
        body.reason || 'CUSTOMER',
        body.refundMethod || 'ORIGINAL',
        body.staffNote,
        body.notify ?? true
      );
      if (result.success) {
        await prisma.thread.update({
          where: { id: threadId },
          data: {
            lastActionType: 'order_cancelled',
            lastActionAt: new Date(),
            lastActionData: {
              orderId: body.orderId,
              refund: true,
            },
          },
        });
      await staleDraftAfterAction();
      }
      return NextResponse.json(result);
    }

    if (body.action === 'cancel_printify') {
      const printifyClient = await createPrintifyClient();
      if (!printifyClient) {
        return NextResponse.json(
          { error: 'Printify not configured' },
          { status: 400 }
        );
      }

      const cached = await prisma.printifyOrderCache.findUnique({
        where: { id: body.printifyOrderId },
      });

      if (!cached?.data) {
        return NextResponse.json(
          { error: 'Printify order not found' },
          { status: 404 }
        );
      }

      const order = cached.data as unknown as PrintifyOrder;
      if (isPrintifyInProduction(order)) {
        return NextResponse.json(
          { error: 'Printify order already shipped' },
          { status: 400 }
        );
      }

      const result = await printifyClient.cancelOrder(body.printifyOrderId);
      if (!result.success) {
        return NextResponse.json(
          { error: result.error || 'Printify cancel failed' },
          { status: 400 }
        );
      }

      await prisma.printifyOrderCache.update({
        where: { id: body.printifyOrderId },
        data: {
          status: 'cancelled',
          lastSyncedAt: new Date(),
        },
      });

      return NextResponse.json({ success: true });
    }

    if (body.action === 'confirm_printify_address') {
      await prisma.thread.update({
        where: { id: threadId },
        data: {
          lastActionType: 'printify_address_confirmed',
          lastActionAt: new Date(),
          lastActionData: {
            orderId: body.orderId,
            printifyOrderId: body.printifyOrderId || null,
          },
        },
      });

      return NextResponse.json({ success: true });
    }

    if (body.action === 'create_replacement') {
      const shopifyClient = await createShopifyClient();
      if (!shopifyClient) {
        return NextResponse.json(
          { error: 'Shopify not configured' },
          { status: 400 }
        );
      }

      const order = await shopifyClient.getOrderById(body.orderId);
      if (!order) {
        return NextResponse.json({ error: 'Order not found' }, { status: 404 });
      }

      const thread = await prisma.thread.findUnique({
        where: { id: threadId },
        select: { customerEmail: true },
      });

      const sizeExchangeReason = body.reason || 'Size exchange';
      const discountType = body.discountType || 'PERCENTAGE';
      const discountRaw = body.discountValue ? parseFloat(body.discountValue) : NaN;
      const discountValue =
        discountType === 'PERCENTAGE'
          ? Math.min(Math.max(isNaN(discountRaw) ? 100 : discountRaw, 0), 100)
          : Math.max(isNaN(discountRaw) ? 0 : discountRaw, 0);
      const incomingTags = body.tags || [];
      const tags = Array.from(
        new Set(['Replacement', 'Size Exchange', ...incomingTags])
      );

      const noteParts = [
        `Replacement order for ${order.name}`,
        sizeExchangeReason,
        body.note,
      ].filter(Boolean);

      const shippingAddr = body.shippingAddress ? nullToUndefined(body.shippingAddress) : order.shippingAddress;
      const billingAddr = body.billingAddress ? nullToUndefined(body.billingAddress) : order.billingAddress;

      const draftResult = await shopifyClient.createDraftOrder({
        email: body.email || order.customerEmail || thread?.customerEmail || undefined,
        customerId: body.customerId || order.customerId || undefined,
        shippingAddress: shippingAddr,
        billingAddress: billingAddr,
        lineItems: body.lineItems,
        note: noteParts.join(' - '),
        tags,
        appliedDiscount: {
          title: sizeExchangeReason,
          value: discountValue,
          valueType: discountType === 'FIXED_AMOUNT' ? 'FIXED_AMOUNT' : 'PERCENTAGE',
        },
        shippingLine: body.shippingLine
          ? { title: body.shippingLine.title, price: body.shippingLine.price }
          : undefined,
      });

      if (!draftResult.success || !draftResult.draftOrderId) {
        return NextResponse.json(
          { error: draftResult.errors?.join(', ') || 'Draft order failed' },
          { status: 400 }
        );
      }

      const completeResult = await shopifyClient.completeDraftOrder(
        draftResult.draftOrderId,
        false
      );

      if (!completeResult.success) {
        return NextResponse.json(
          {
            error: completeResult.errors?.join(', ') || 'Draft order completion failed',
            draftOrderId: draftResult.draftOrderId,
          },
          { status: 400 }
        );
      }

      const outstandingAmount = completeResult.totalOutstanding
        ? parseFloat(completeResult.totalOutstanding)
        : 0;

      if (
        completeResult.orderId &&
        completeResult.displayFinancialStatus !== 'PAID' &&
        completeResult.canMarkAsPaid &&
        Number.isFinite(outstandingAmount) &&
        outstandingAmount > 0
      ) {
        const markPaidResult = await shopifyClient.markOrderAsPaid(
          completeResult.orderId
        );
        if (!markPaidResult.success) {
          console.warn('Failed to mark replacement order as paid:', markPaidResult);
        }
      }

      if (completeResult.success) {
        await prisma.thread.update({
          where: { id: threadId },
          data: {
            lastActionType: 'replacement_created',
            lastActionAt: new Date(),
            lastActionData: {
              orderId: body.orderId,
              replacementOrderId: completeResult.orderId,
              replacementOrderName: completeResult.orderName,
              discountType,
              discountValue,
              reason: sizeExchangeReason,
            },
          },
        });

        // The size-exchange draft was held until now; mark it stale so the
        // worker regenerates a confirmation reply that references the new order.
        await prisma.aiDraft
          .updateMany({
            where: { threadId, status: { in: ['AWAITING_ACTION', 'READY'] } },
            data: { status: 'STALE' },
          })
          .catch(() => undefined);
      }

      // Fire-and-forget Printify sync - don't block the response
      // The client will trigger a refresh anyway after 15 seconds
      syncPrintifyOrders().catch((err) => {
        console.warn('Printify sync after replacement failed:', err);
      });

      return NextResponse.json({
        success: true,
        orderId: completeResult.orderId,
        orderName: completeResult.orderName,
        draftOrderId: draftResult.draftOrderId,
        printifySyncTriggered: true,
      });
    }

    if (body.action === 'refund') {
      const shopifyClient = await createShopifyClient();
      if (!shopifyClient) {
        return NextResponse.json(
          { error: 'Shopify not configured' },
          { status: 400 }
        );
      }

      const result = await shopifyClient.refundOrder(body.orderId, {
        amount: body.amount,
        reason: body.reason,
        refundShipping: body.refundShipping,
        shippingAmount: body.shippingAmount,
        notify: body.notify,
      });

      if (!result.success) {
        return NextResponse.json(
          { error: result.errors?.join(', ') || 'Refund failed' },
          { status: 400 }
        );
      }

      await prisma.thread.update({
        where: { id: threadId },
        data: {
          lastActionType: 'order_refunded',
          lastActionAt: new Date(),
          lastActionData: {
            orderId: body.orderId,
            refundedAmount: result.refundedAmount,
            shippingRefunded: body.refundShipping || false,
            reason: body.reason || null,
          },
        },
      });
      await staleDraftAfterAction();

      return NextResponse.json({
        success: true,
        refundedAmount: result.refundedAmount,
      });
    }

    if (body.action === 'discount_adjustment') {
      const shopifyClient = await createShopifyClient();
      if (!shopifyClient) {
        return NextResponse.json({ error: 'Shopify not configured' }, { status: 400 });
      }

      const order = await shopifyClient.getOrderById(body.orderId);
      if (!order) {
        return NextResponse.json({ error: 'Order not found' }, { status: 404 });
      }

      const subtotal = parseFloat(order.subtotalPrice || '0');
      const alreadyRefunded = parseFloat(order.totalRefunded || '0');
      const total = parseFloat(order.totalPrice || '0');
      const refundableCeiling = Math.max(0, total - alreadyRefunded);

      let label = 'Discount adjustment';
      let amount = 0;

      if (body.code) {
        const discount = await shopifyClient.lookupDiscountByCode(body.code);
        if (!discount) {
          return NextResponse.json(
            {
              error: `Couldn't find discount code "${body.code}" in Shopify (or no read_discounts access). Enter a percentage manually instead.`,
            },
            { status: 404 }
          );
        }
        label = `Discount honored: ${body.code}`;
        amount =
          discount.valueType === 'percentage'
            ? subtotal * discount.percentage
            : Math.min(parseFloat(discount.amount), subtotal);
      } else if (typeof body.percentage === 'number') {
        label = `Discount adjustment (${body.percentage}%)`;
        amount = subtotal * (Math.max(0, Math.min(body.percentage, 100)) / 100);
      } else {
        return NextResponse.json(
          { error: 'Provide a discount code or a percentage.' },
          { status: 400 }
        );
      }

      amount = Math.min(amount, refundableCeiling);
      if (!(amount > 0)) {
        return NextResponse.json(
          { error: 'Computed refund is zero (already refunded or code has no value).' },
          { status: 400 }
        );
      }
      const amountStr = amount.toFixed(2);

      const result = await shopifyClient.refundOrder(body.orderId, {
        amount: amountStr,
        reason: label,
        notify: body.notify ?? true,
      });

      if (!result.success) {
        return NextResponse.json(
          { error: result.errors?.join(', ') || 'Refund failed' },
          { status: 400 }
        );
      }

      await prisma.thread.update({
        where: { id: threadId },
        data: {
          lastActionType: 'discount_adjusted',
          lastActionAt: new Date(),
          lastActionData: {
            orderId: body.orderId,
            code: body.code || null,
            refundedAmount: result.refundedAmount || amountStr,
            label,
          },
        },
      });
      await staleDraftAfterAction();

      return NextResponse.json({
        success: true,
        refundedAmount: result.refundedAmount || amountStr,
        label,
      });
    }

    if (body.action === 'create_draft_order') {
      const shopifyClient = await createShopifyClient();
      if (!shopifyClient) {
        return NextResponse.json(
          { error: 'Shopify not configured' },
          { status: 400 }
        );
      }

      const result = await shopifyClient.createDraftOrder({
        customerId: body.customerId,
        email: body.email,
        lineItems: body.lineItems,
        shippingAddress: body.shippingAddress ? nullToUndefined(body.shippingAddress) : undefined,
        appliedDiscount: body.discount
          ? {
              title: body.discount.title,
              value: body.discount.value,
              valueType: body.discount.type,
            }
          : undefined,
        shippingLine: body.shippingPrice
          ? {
              title: body.shippingTitle || 'Shipping',
              price: body.shippingPrice,
            }
          : undefined,
        note: body.note,
        tags: body.tags,
      });

      if (!result.success) {
        return NextResponse.json(
          { error: result.errors?.join(', ') || 'Failed to create draft order' },
          { status: 400 }
        );
      }

      return NextResponse.json({
        success: true,
        draftOrderId: result.draftOrderId,
        draftOrderName: result.draftOrderName,
        invoiceUrl: result.invoiceUrl,
      });
    }

    if (body.action === 'edit_order') {
      const shopifyClient = await createShopifyClient();
      if (!shopifyClient) {
        return NextResponse.json(
          { error: 'Shopify not configured' },
          { status: 400 }
        );
      }

      const result = await shopifyClient.editOrder({
        orderId: body.orderId,
        addItems: body.addItems,
        removeLineItemIds: body.removeLineItemIds,
        updateQuantities: body.updateQuantities,
        notifyCustomer: body.notifyCustomer ?? true,
        staffNote: body.staffNote,
      });

      if (!result.success) {
        return NextResponse.json(
          { error: result.errors?.join(', ') || 'Edit failed', errors: result.errors },
          { status: 400 }
        );
      }

      await prisma.thread.update({
        where: { id: threadId },
        data: {
          lastActionType: 'order_edited',
          lastActionAt: new Date(),
          lastActionData: {
            orderId: body.orderId,
            orderName: result.orderName,
            addedItems: body.addItems?.length || 0,
            removedItems: body.removeLineItemIds?.length || 0,
          },
        },
      });
      await staleDraftAfterAction();

      return NextResponse.json({
        success: true,
        orderId: result.orderId,
        orderName: result.orderName,
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    console.error('Error processing order action:', err);
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: 'Invalid request',
          details: err.issues,
        },
        { status: 400 }
      );
    }
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
