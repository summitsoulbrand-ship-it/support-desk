/**
 * Order actions API - Shopify/Printify actions for a thread
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession, hasPermission, isAdmin } from '@/lib/auth';
import prisma from '@/lib/db';
import {
  logAction,
  dollarsToCents,
  getRefundThresholdCents,
} from '@/lib/audit';
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
    action: z.literal('escalate_printify'),
    orderId: z.string(),
    printifyOrderId: z.string().optional(),
  }),
  z.object({
    // Pre-production order change: swap the printed item, keep the customer's
    // payment. Cancels the not-yet-made Printify order and recreates it.
    action: z.literal('change_preproduction'),
    orderId: z.string(), // Shopify order gid
    printifyOrderId: z.string(),
    lineItems: z.array(
      z.object({
        sku: z.string().optional(),
        variantId: z.string().optional(), // Shopify variant gid, for the order edit
        variantLabel: z.string().optional(), // e.g. "Blue Jean / L", resolves Printify variant
        quantity: z.number().int().positive(),
        price: z.string().optional(), // new item unit price (retail)
      })
    ),
    // Set true to proceed even when the upcharge is $20+ (operator collected it)
    force: z.boolean().optional(),
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

    // Who is performing this action (for the audit log)
    const actor = {
      threadId,
      userId: session.user.id,
      userName: session.user.name || session.user.email || 'Unknown',
    };

    // Money-action gate for non-admins: a cancellation refunds the WHOLE
    // order and a discount adjustment refunds a slice of it, so when a
    // refund-approval threshold is configured these need an admin exactly
    // like an over-threshold refund (a cancel is over any threshold by
    // definition). Threshold 0 = no gate, same as refunds.
    const requireAdminForMoneyAction = async (): Promise<NextResponse | null> => {
      if (isAdmin(session.user.role)) return null;
      const threshold = await getRefundThresholdCents();
      if (threshold <= 0) return null;
      return NextResponse.json(
        {
          error:
            'This action refunds money and needs an admin to approve. Escalate the thread to Pati instead.',
          needsAdminApproval: true,
        },
        { status: 403 }
      );
    };

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

    // For SIZE EXCHANGES / REPLACEMENTS, Pati keeps the existing draft - the
    // first reply already confirms the exchange and is good as-is, so we do NOT
    // overwrite a READY draft. Only a held placeholder (AWAITING_ACTION, no
    // body) or a failed one is retired, so the confirmation still appears when
    // there was no usable draft yet.
    const staleHeldDraftAfterAction = () =>
      prisma.aiDraft
        .updateMany({
          where: { threadId, status: { in: ['AWAITING_ACTION', 'FAILED'] } },
          data: { status: 'STALE' },
        })
        .catch(() => undefined);

    if (body.action === 'update_shipping') {
      // A Printify order link needs the shop id, else it bounces to the orders
      // list. Build it once for the in-production escalation deep links below.
      const printifyShopId = (await createPrintifyClient())?.getShopId() || null;
      const printifyOrderUrl = (oid: string) =>
        printifyShopId
          ? `https://printify.com/app/store/${printifyShopId}/order/${oid}`
          : `https://printify.com/app/orders/${oid}`;

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
      let printifyInProduction = false;
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
            'Ship a corrected replacement to the new address, or use a carrier intercept if the package will misdeliver.';
          printifyDeepLink = printifyOrderUrl(body.printifyOrderId);
          printifyInProduction = true;
          // Flag for the Needs Attention queue so this can't be forgotten.
          await prisma.thread
            .update({
              where: { id: threadId },
              data: {
                needsManual: true,
                manualReason:
                  'Address change requested but the order is already in production - ship a corrected replacement or arrange a carrier intercept.',
                manualResolvedAt: null,
              },
            })
            .catch(() => undefined);
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
        printifyInProduction,
        newPrintifyOrderId,
      });
    }

    if (body.action === 'cancel_both') {
      const gate = await requireAdminForMoneyAction();
      if (gate) return gate;

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
            printify.deepLink = printifyClient.getShopId()
              ? `https://printify.com/app/store/${printifyClient.getShopId()}/order/${body.printifyOrderId}`
              : `https://printify.com/app/orders/${body.printifyOrderId}`;

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
      await logAction({
        ...actor,
        action: 'cancel_both',
        summary: `Cancelled + refunded order (Printify ${printify.success ? 'cancelled' : 'not cancelled'})`,
        metadata: {
          orderId: body.orderId,
          printifyOrderId: body.printifyOrderId || null,
        },
      });
      }

      return NextResponse.json({
        success: shopify.success,
        shopify,
        printify,
      });
    }

    if (body.action === 'cancel_shopify') {
      const gate = await requireAdminForMoneyAction();
      if (gate) return gate;

      const shopifyClient = await createShopifyClient();
      if (!shopifyClient) {
        return NextResponse.json(
          { error: 'Shopify not configured' },
          { status: 400 }
        );
      }

      // Race guard: the UI sends cancel_shopify when it saw NO Printify match,
      // but on a brand-new order the Printify order can appear seconds after
      // the sidebar loaded (#27211, 2026-07-10). Re-check the webhook-fed
      // cache at cancel time and take a pre-production Printify order down
      // too. Store-linked orders are also covered by Printify's native
      // propagation; desk-created replacements and manual orders have no such
      // link, so this guard is what saves those.
      let printifyGuard: { cancelled?: string; warning?: string } | undefined;
      try {
        const numericId = body.orderId.replace('gid://shopify/Order/', '');
        const cached = await prisma.printifyOrderCache.findFirst({
          where: {
            metadataShopOrderId: numericId,
            NOT: { status: { contains: 'cancel', mode: 'insensitive' } },
          },
        });
        if (cached) {
          const po = cached.data as unknown as PrintifyOrder;
          const printifyClient = await createPrintifyClient();
          if (printifyClient && PrintifyClient.canCancelOrder(po)) {
            const r = await printifyClient.cancelOrder(cached.id);
            if (r.success) {
              printifyGuard = { cancelled: cached.id };
              await prisma.printifyOrderCache.update({
                where: { id: cached.id },
                data: { status: 'cancelled', lastSyncedAt: new Date() },
              }).catch(() => undefined);
            } else {
              printifyGuard = {
                warning: `Printify order ${cached.id} could not be cancelled (${r.error || 'unknown error'}) - check it in Printify.`,
              };
            }
          } else if (printifyClient) {
            printifyGuard = {
              warning: `A Printify order for this order is already in production (${cached.id}) - request cancellation in Printify if needed.`,
            };
          }
        }
      } catch (err) {
        console.warn('[cancel_shopify] printify race guard failed:', err);
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
              printifyCancelled: printifyGuard?.cancelled || null,
            },
          },
        });
      await staleDraftAfterAction();
      await logAction({
        ...actor,
        action: 'cancel_shopify',
        summary: `Cancelled + refunded the Shopify order${
          printifyGuard?.cancelled
            ? ' (race guard also cancelled the Printify order)'
            : printifyGuard?.warning
              ? ' (Printify NOT cancelled - see warning)'
              : ''
        }`,
        metadata: { orderId: body.orderId, printifyGuard: printifyGuard || null },
      });
      }
      return NextResponse.json({ ...result, printifyGuard });
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

      await staleDraftAfterAction();
      return NextResponse.json({ success: true });
    }

    // Delivered-but-not-received: Printify has no claims API, so this records
    // that the VA escalated the lost-delivery case to Printify (who handles the
    // claim and ships the replacement). The marker drives the done-state so the
    // button is not offered twice on the same thread.
    if (body.action === 'escalate_printify') {
      await prisma.thread.update({
        where: { id: threadId },
        data: {
          lastActionType: 'escalated_to_printify',
          lastActionAt: new Date(),
          lastActionData: {
            orderId: body.orderId,
            printifyOrderId: body.printifyOrderId || null,
          },
        },
      });

      await staleDraftAfterAction();
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

        // Keep an existing READY draft (Pati's first reply already confirms the
        // exchange). Only a held placeholder regenerates into a confirmation.
        await staleHeldDraftAfterAction();
      }

      await logAction({
        ...actor,
        action: 'create_replacement',
        summary: `Created free replacement order ${completeResult.orderName || ''}`.trim(),
        orderName: completeResult.orderName || null,
        metadata: { forOrderId: body.orderId, replacementOrderId: completeResult.orderId },
      });

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

    if (body.action === 'change_preproduction') {
      const shopifyClient = await createShopifyClient();
      if (!shopifyClient) {
        return NextResponse.json({ error: 'Shopify not configured' }, { status: 400 });
      }
      const order = await shopifyClient.getOrderById(body.orderId);
      if (!order) {
        return NextResponse.json({ error: 'Order not found' }, { status: 404 });
      }

      // Two different "differences", which MUST NOT be conflated (conflating
      // them once reported a $3 size bump as a ~$21 upcharge when the original
      // order used a discount code):
      // - diff (product-price difference): the swapped-in lines vs the lines
      //   they replace, both at FULL catalog price. This is the genuine
      //   upcharge - what the $20 gate and the operator-facing number use.
      // - balanceDelta (money difference): what Shopify will show as balance
      //   due after the edit (every line re-added at full catalog price vs
      //   what the customer actually PAID). This is the courtesy discount
      //   needed to keep the order fully paid - it re-grants their discount
      //   code on top of absorbing any small product upcharge.
      // Client-sent prices are only trusted for genuinely swapped-in lines
      // (they come from the variant picker at full price); unchanged lines are
      // paired by variantId so whatever basis the client sent cancels out.
      const origLines = order.lineItems.map((li) => ({
        variantId: li.variantId,
        qty: li.quantity,
        full: parseFloat(li.originalUnitPrice || li.discountedUnitPrice || '0'),
        paid: parseFloat(li.discountedUnitPrice || li.originalUnitPrice || '0'),
      }));
      const unmatchedOrig = [...origLines];
      let swappedInTotal = 0; // swapped-in lines at full variant price
      let keptFullTotal = 0; // unchanged lines re-added at their catalog price
      for (const li of body.lineItems) {
        const idx = li.variantId
          ? unmatchedOrig.findIndex(
              (o) => o.variantId === li.variantId && o.qty === li.quantity
            )
          : -1;
        if (idx >= 0) {
          keptFullTotal += unmatchedOrig[idx].full * unmatchedOrig[idx].qty;
          unmatchedOrig.splice(idx, 1);
        } else {
          swappedInTotal += parseFloat(li.price || '0') * li.quantity;
        }
      }
      const removedFull = unmatchedOrig.reduce((s, o) => s + o.full * o.qty, 0);
      const origPaid = origLines.reduce((s, o) => s + o.paid * o.qty, 0);
      const diff = Math.round((swappedInTotal - removedFull) * 100) / 100;
      const balanceDelta =
        Math.round((keptFullTotal + swappedInTotal - origPaid) * 100) / 100;

      // Upcharge of $20+ needs the operator to collect it first.
      if (diff >= 20 && !body.force) {
        return NextResponse.json(
          {
            error: `The new item(s) cost $${diff.toFixed(2)} more - that's $20 or more, so collect the difference from the customer first, then confirm to proceed.`,
            needsPaymentDecision: true,
            priceDifference: diff,
          },
          { status: 409 }
        );
      }

      // Cancel the not-yet-made Printify order and recreate it with the new
      // items, keeping the customer's Shopify order/payment intact.
      const result = await recreatePrintifyOrder({
        printifyOrderId: body.printifyOrderId,
        shopifyOrderId: order.id,
        shopifyOrderName: order.name,
        reason: 'ITEM_CHANGE',
        lineItems: body.lineItems.map((li) => ({
          sku: li.sku,
          variantLabel: li.variantLabel,
          quantity: li.quantity,
        })),
      });

      if (!result.success) {
        if (result.inProduction) {
          return NextResponse.json(
            {
              error:
                'This order is already in production - it can no longer be changed automatically. Use the replacement flow instead.',
              inProduction: true,
            },
            { status: 409 }
          );
        }
        return NextResponse.json(
          { error: result.error || 'Could not change the order' },
          { status: 400 }
        );
      }

      // Printify is now remade with the new item. Edit the original Shopify
      // order so its record matches: remove the original line item(s), add the
      // requested variant(s). Done after the Printify recreate so the old
      // Printify link is already cancelled and the Shopify edit can't disturb
      // the freshly-created (API-side) replacement order.
      let shopifyEditWarning: string | null = null;
      const editItems = body.lineItems.filter((li) => li.variantId);
      if (editItems.length === body.lineItems.length && order.lineItems.length > 0) {
        // Courtesy discount on the first new item so the order stays paid in
        // full (we promised not to charge more). CRITICAL: Shopify RE-APPLIES
        // an order-level percentage code (WELCOME15 etc.) over the edited
        // lines, so the absorb must target the PRE-code price, not the paid
        // price - marking straight down to the paid price double-discounts and
        // leaves a refund owed (2026-07-10: $6.24 absorb + 15% recalc = $4.45
        // owed to the customer). We derive the code's rate from the original
        // lines (paid vs full) and gross the target back up; with no code the
        // math reduces to the old behavior. When the operator collected a $20+
        // upcharge (force), that part stays as a balance due. Cheaper items
        // get refunded below instead.
        const origFull = origLines.reduce((s, o) => s + o.full * o.qty, 0);
        const pctRate =
          origFull > 0.01
            ? Math.min(0.9, Math.max(0, 1 - origPaid / origFull))
            : 0;
        const grossUp = (net: number) =>
          pctRate > 0.001 ? net / (1 - pctRate) : net;
        const newFullTotal = keptFullTotal + swappedInTotal;
        const targetNet = diff >= 20 ? origPaid + diff : origPaid;
        const absorb = Math.max(
          0,
          Math.round((newFullTotal - grossUp(targetNet)) * 100) / 100
        );
        const editRes = await shopifyClient.editOrder({
          orderId: order.id,
          removeLineItemIds: order.lineItems.map((li) => li.id),
          addItems: editItems.map((li, idx) => ({
            variantId: li.variantId as string,
            quantity: li.quantity,
            discount: idx === 0 && absorb > 0.001 ? absorb.toFixed(2) : undefined,
          })),
          notifyCustomer: false,
          staffNote: 'Pre-production item change - swapped the item, kept payment.',
        });
        if (!editRes.success) {
          shopifyEditWarning =
            'Printify was updated, but editing the Shopify order line items failed - update it by hand. ' +
            (editRes.errors?.join(', ') || '');
        }
      } else if (editItems.length !== body.lineItems.length) {
        shopifyEditWarning =
          'Printify was updated, but the Shopify order line items were left as-is (the new items had no variant id).';
      }

      // Cheaper new item -> refund the difference. Money basis (what they
      // actually paid), not the full-price product basis.
      let refundedAmount: string | null = null;
      if (balanceDelta < -0.001) {
        const refundRes = await shopifyClient.refundOrder(order.id, {
          amount: Math.abs(balanceDelta).toFixed(2),
          reason: 'Pre-production item change - cheaper item, refunding the difference',
          notify: true,
        });
        if (refundRes.success) {
          refundedAmount =
            refundRes.refundedAmount || Math.abs(balanceDelta).toFixed(2);
        }
      }

      await prisma.thread.update({
        where: { id: threadId },
        data: {
          lastActionType: 'item_changed_preproduction',
          lastActionAt: new Date(),
          lastActionData: {
            orderId: body.orderId,
            newPrintifyOrderId: result.newPrintifyOrderId,
            priceDifference: diff,
            balanceDelta,
          },
        },
      });
      // Size change before production - keep the existing READY draft.
      await staleHeldDraftAfterAction();

      // diff >= 20 only reaches here with force=true (operator collected the
      // product-price difference). The edited Shopify order shows that part as
      // a balance due, so remind them to mark it paid.
      const note =
        balanceDelta < -0.001
          ? ` (refunded $${Math.abs(balanceDelta).toFixed(2)})`
          : diff >= 20
            ? ` (+$${diff.toFixed(2)} collected by you - mark the Shopify balance paid)`
            : balanceDelta > 0.001
              ? ` (absorbed $${balanceDelta.toFixed(2)}: $${Math.max(0, diff).toFixed(2)} upcharge + their original discount re-granted)`
              : '';
      await logAction({
        ...actor,
        action: 'change_preproduction',
        summary: `Changed item before production on ${order.name}${note}${
          shopifyEditWarning ? ' [Shopify order not edited - see warning]' : ''
        }`,
        orderName: order.name,
        amountCents: dollarsToCents(Math.abs(balanceDelta).toFixed(2)),
        metadata: {
          orderId: body.orderId,
          priceDifference: diff,
          balanceDelta,
          shopifyEditWarning,
        },
      });

      syncPrintifyOrders().catch(() => undefined);

      return NextResponse.json({
        success: true,
        newPrintifyOrderId: result.newPrintifyOrderId,
        priceDifference: diff,
        refundedAmount,
        shopifyEditWarning,
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

      // Money-action gate: refunds at/above the configured threshold need an
      // admin. Admins are always allowed. 0 threshold = no gate.
      const requestedCents = dollarsToCents(body.amount);
      if (!isAdmin(session.user.role)) {
        const threshold = await getRefundThresholdCents();
        // A blank amount means "full refund" - treat as over any threshold.
        const overThreshold =
          threshold > 0 &&
          (requestedCents === null || requestedCents >= threshold);
        if (overThreshold) {
          return NextResponse.json(
            {
              error:
                'This refund needs an admin to approve. Ask an admin to issue it, or enter a smaller amount.',
              needsAdminApproval: true,
            },
            { status: 403 }
          );
        }
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

      await logAction({
        ...actor,
        action: 'refund',
        amountCents: dollarsToCents(result.refundedAmount) ?? requestedCents,
        summary: `Refunded ${result.refundedAmount ? `$${result.refundedAmount}` : 'order'}${body.refundShipping ? ' (incl. shipping)' : ''}`,
        metadata: { orderId: body.orderId, reason: body.reason || null },
      });

      return NextResponse.json({
        success: true,
        refundedAmount: result.refundedAmount,
      });
    }

    if (body.action === 'discount_adjustment') {
      const gate = await requireAdminForMoneyAction();
      if (gate) return gate;

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
      await logAction({
        ...actor,
        action: 'discount_adjustment',
        amountCents: dollarsToCents(result.refundedAmount || amountStr),
        summary: `Goodwill discount/partial refund ${label}`.trim(),
        metadata: { orderId: body.orderId, code: body.code || null },
      });

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
