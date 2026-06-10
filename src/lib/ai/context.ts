/**
 * Shared suggestion-context builder
 * One code path for both the manual /api/threads/[id]/suggest route and the
 * background pre-draft pipeline. With forceFresh, Shopify order data,
 * Printify production status, and carrier tracking are re-fetched live and
 * the caches updated, so drafts never quote stale information.
 */

import prisma from '@/lib/db';
import {
  SuggestionContext,
  MessageContext,
  buildShopifyContext,
  buildPrintifyContext,
  buildTrackingContext,
} from '@/lib/claude/types';
import { ShopifyCustomer, ShopifyOrder } from '@/lib/shopify/types';
import { createShopifyClient } from '@/lib/shopify';
import { createPrintifyClient, type PrintifyOrder } from '@/lib/printify';
import { createTrackingMoreClient, type TrackingResult } from '@/lib/trackingmore';
import { getKnowledgeBlocks } from '@/lib/knowledge';
import { matchOrderForRequest } from '@/lib/ai/order-match';

export interface BuildContextOptions {
  /** Re-fetch Shopify/Printify/tracking live and update caches */
  forceFresh?: boolean;
  /** Agent identity for the signature block */
  agent?: { name: string; signature?: string };
  /** Include few-shot feedback examples (default true) */
  includeFeedbackExamples?: boolean;
}

export interface BuiltThreadContext {
  context: SuggestionContext;
  warnings: string[];
  /** id of the newest INBOUND message, for draft staleness tracking */
  latestInboundMessageId: string | null;
  contextRefreshedAt: Date | null;
}

/** How fresh cached tracking must be to skip a live refetch (forceFresh mode) */
const TRACKING_FRESH_MS = 60 * 60 * 1000; // 1 hour

interface CustomerOrders {
  customer: ShopifyCustomer | null;
  orders: ShopifyOrder[];
}

async function getCachedCustomerOrders(email: string): Promise<CustomerOrders | null> {
  const cached = await prisma.customerLink.findUnique({ where: { email } });
  if (!cached?.shopifyData) return null;

  const data = cached.shopifyData as {
    customer?: ShopifyCustomer;
    orders?: ShopifyOrder[];
  };
  if (!data.orders || data.orders.length === 0) return null;

  return { customer: data.customer || null, orders: data.orders };
}

async function getFreshCustomerOrders(email: string): Promise<CustomerOrders | null> {
  const shopifyClient = await createShopifyClient();
  if (!shopifyClient) return null;

  const customerData = await shopifyClient.getCustomerWithOrders(email, 10);
  let result: CustomerOrders | null = null;

  if (customerData) {
    result = { customer: customerData.customer, orders: customerData.orders };
  } else {
    // Guest checkout fallback: orders by email without a customer account
    const emailOrders = await shopifyClient.getOrdersByEmail(email, 10);
    if (emailOrders.length > 0) {
      result = { customer: null, orders: emailOrders };
    }
  }

  if (result) {
    const cacheData = {
      customer: result.customer || undefined,
      orders: result.orders,
    };
    await prisma.customerLink.upsert({
      where: { email },
      create: {
        email,
        shopifyCustomerId: result.customer?.id,
        shopifyData: JSON.parse(JSON.stringify(cacheData)),
        lastVerifiedAt: new Date(),
      },
      update: {
        shopifyCustomerId: result.customer?.id || undefined,
        shopifyData: JSON.parse(JSON.stringify(cacheData)),
        lastVerifiedAt: new Date(),
      },
    });
  }

  return result;
}

/**
 * Build the full SuggestionContext for a thread.
 * Returns null only if the thread does not exist.
 */
export async function buildThreadSuggestionContext(
  threadId: string,
  options: BuildContextOptions = {}
): Promise<BuiltThreadContext | null> {
  const { forceFresh = false, agent, includeFeedbackExamples = true } = options;
  const warnings: string[] = [];
  let contextRefreshedAt: Date | null = null;

  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: {
      messages: { orderBy: { sentAt: 'asc' } },
      triage: true,
    },
  });

  if (!thread) return null;

  const latestInbound = [...thread.messages]
    .reverse()
    .find((m) => m.direction === 'INBOUND');

  const context: SuggestionContext = {
    messages: thread.messages.map(
      (msg): MessageContext => ({
        from:
          msg.direction === 'INBOUND'
            ? `${thread.customerName || thread.customerEmail}`
            : 'Support Team',
        date: msg.sentAt.toISOString(),
        subject: msg.subject,
        body: msg.bodyText || msg.bodyHtml?.replace(/<[^>]*>/g, '') || '',
      })
    ),
    agent,
  };

  if (thread.lastActionType && thread.lastActionAt) {
    context.recentAction = {
      type: thread.lastActionType,
      at: thread.lastActionAt.toISOString(),
      data: (thread.lastActionData as Record<string, unknown> | null) || undefined,
    };
  }

  if (thread.triage) {
    context.triage = {
      intent: thread.triage.intent,
      confidence: thread.triage.confidence,
      entities:
        (thread.triage.entities as Record<string, unknown> | null) || undefined,
    };
  }

  // --- Shopify customer + orders ---
  let match: CustomerOrders | null = null;
  try {
    if (forceFresh) {
      try {
        match = await getFreshCustomerOrders(thread.customerEmail);
        if (match) contextRefreshedAt = new Date();
      } catch (err) {
        console.error('Live Shopify fetch failed, falling back to cache:', err);
      }
    }
    if (!match) {
      match = await getCachedCustomerOrders(thread.customerEmail);
      if (match && forceFresh) {
        warnings.push('Order data is from cache - live Shopify fetch was unavailable');
      }
    }
  } catch (err) {
    console.error('Error fetching order context:', err);
  }

  if (match) {
    // When there are multiple orders, identify which one the request is about
    // (or flag it ambiguous) and surface the full list so the model can ask.
    if (match.orders.length > 1) {
      const entities =
        (thread.triage?.entities as Record<string, string | undefined> | null) || {};
      const matchResult = matchOrderForRequest(match.orders, {
        orderNumber: entities.orderNumber,
        lineItemHint: entities.lineItemHint,
        currentSize: entities.currentSize,
      });

      context.orderCandidates = match.orders.map((o) => ({
        orderNumber: o.name,
        createdAt: o.createdAt,
        fulfillmentStatus: o.fulfillmentStatus,
        items: o.lineItems.map(
          (li) => `${li.title}${li.variantTitle ? ` - ${li.variantTitle}` : ''} (x${li.quantity})`
        ),
      }));

      const matchedOrder = matchResult.matchedOrderId
        ? match.orders.find((o) => o.id === matchResult.matchedOrderId)
        : undefined;

      context.orderMatch = {
        matchedOrderNumber: matchedOrder?.name,
        ambiguous: matchResult.ambiguous,
        reason: matchResult.reason,
      };

      // Put the matched order first so the detailed order + Printify/tracking
      // context below describe the right one.
      if (matchedOrder) {
        match.orders = [
          matchedOrder,
          ...match.orders.filter((o) => o.id !== matchedOrder.id),
        ];
      }
    }

    if (match.customer) {
      Object.assign(context, buildShopifyContext(match.customer, match.orders));
    } else if (match.orders.length > 0) {
      const order = match.orders[0];
      context.shopifyOrder = {
        orderNumber: order.name,
        status: order.financialStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        createdAt: order.createdAt,
        totalPrice: order.totalPrice,
        currency: order.totalPriceCurrency,
        lineItems: order.lineItems.map((li) => ({
          title: li.title + (li.variantTitle ? ` - ${li.variantTitle}` : ''),
          quantity: li.quantity,
        })),
        trackingNumber: order.fulfillments[0]?.trackingNumber,
        trackingUrl: order.fulfillments[0]?.trackingUrl,
        shippingAddress: order.shippingAddress
          ? [
              order.shippingAddress.address1,
              order.shippingAddress.city,
              order.shippingAddress.provinceCode,
              order.shippingAddress.zip,
              order.shippingAddress.countryCode,
            ]
              .filter(Boolean)
              .join(', ')
          : undefined,
      };
    }

    // --- Printify production status for the most recent order ---
    if (match.orders.length > 0) {
      const order = match.orders[0];
      const candidates = [
        order.name,
        order.name?.replace('#', ''),
        order.orderNumber?.toString(),
        order.id?.replace('gid://shopify/Order/', ''),
      ].filter(Boolean) as string[];

      try {
        const cachedOrder = await prisma.printifyOrderCache.findFirst({
          where: {
            OR: [
              { externalId: { in: candidates } },
              { label: { in: candidates } },
              { metadataShopOrderId: { in: candidates } },
              { metadataShopOrderLabel: { in: candidates } },
            ],
          },
          orderBy: { updatedAt: 'desc' },
        });

        let printifyOrder = cachedOrder?.data as unknown as PrintifyOrder | undefined;

        // Live refresh of the matched Printify order
        if (forceFresh && cachedOrder) {
          try {
            const printifyClient = await createPrintifyClient();
            const fresh = printifyClient
              ? await printifyClient.getOrder(cachedOrder.id)
              : null;
            if (fresh) {
              printifyOrder = fresh;
              await prisma.printifyOrderCache.update({
                where: { id: cachedOrder.id },
                data: {
                  status: fresh.status,
                  data: JSON.parse(JSON.stringify(fresh)),
                  lastSyncedAt: new Date(),
                },
              });
            }
          } catch (err) {
            console.error('Live Printify refresh failed, using cache:', err);
          }
        }

        if (printifyOrder) {
          Object.assign(context, buildPrintifyContext(printifyOrder));

          // --- Carrier tracking for the latest shipment ---
          const shipment = printifyOrder.shipments?.[0];
          if (shipment?.number && shipment?.carrier) {
            const cachedTracking = await prisma.trackingCache.findUnique({
              where: {
                trackingNumber_carrier: {
                  trackingNumber: shipment.number,
                  carrier: shipment.carrier,
                },
              },
            });

            let tracking = cachedTracking?.data as unknown as TrackingResult | undefined;
            const trackingIsFresh =
              cachedTracking &&
              Date.now() - cachedTracking.fetchedAt.getTime() < TRACKING_FRESH_MS;
            const trackingIsFinal =
              tracking?.status === 'delivered' || tracking?.status === 'expired';

            if (forceFresh && !trackingIsFresh && !trackingIsFinal) {
              try {
                const trackingClient = await createTrackingMoreClient();
                if (trackingClient) {
                  const fresh = await trackingClient.trackShipment(
                    shipment.number,
                    shipment.carrier
                  );
                  tracking = fresh;
                  await prisma.trackingCache.upsert({
                    where: {
                      trackingNumber_carrier: {
                        trackingNumber: shipment.number,
                        carrier: shipment.carrier,
                      },
                    },
                    create: {
                      trackingNumber: shipment.number,
                      carrier: shipment.carrier,
                      data: fresh as object,
                      fetchedAt: new Date(),
                    },
                    update: {
                      data: fresh as object,
                      fetchedAt: new Date(),
                    },
                  });
                }
              } catch (err) {
                console.error('Live tracking refresh failed, using cache:', err);
              }
            }

            if (tracking) {
              Object.assign(context, buildTrackingContext(tracking, printifyOrder));
            }
          }
        }
      } catch (err) {
        console.error('Error building Printify/tracking context:', err);
      }
    }
  }

  // --- Store knowledge (brand voice, avatar, Shopify pages/policies, catalog) ---
  // The full product list is only worth its tokens for product/availability
  // questions (intent OTHER or pre-purchase with no order context).
  try {
    const includeProductCatalog =
      !thread.triage ||
      thread.triage.intent === 'OTHER' ||
      thread.triage.intent === 'PRODUCT_QUESTION';
    const knowledge = await getKnowledgeBlocks({ includeProductCatalog });
    if (knowledge.length > 0) {
      context.knowledge = knowledge;
    }
  } catch (err) {
    console.error('Error loading store knowledge:', err);
  }

  // --- Few-shot feedback examples ---
  if (includeFeedbackExamples) {
    try {
      const threadTags = await prisma.threadTag.findMany({
        where: { threadId },
        include: { tag: true },
      });
      const tagNames = threadTags.map((tt) => tt.tag.name);

      let feedbackRecords;
      if (tagNames.length > 0) {
        feedbackRecords = await prisma.suggestionFeedback.findMany({
          where: { threadTags: { hasSome: tagNames } },
          orderBy: { createdAt: 'desc' },
          take: 3,
        });
      }

      if (!feedbackRecords || feedbackRecords.length === 0) {
        feedbackRecords = await prisma.suggestionFeedback.findMany({
          orderBy: { createdAt: 'desc' },
          take: 3,
        });
      }

      if (feedbackRecords.length > 0) {
        context.feedbackExamples = feedbackRecords.map((f) => ({
          original: f.originalDraft,
          edited: f.editedDraft,
        }));

        await prisma.suggestionFeedback.updateMany({
          where: { id: { in: feedbackRecords.map((f) => f.id) } },
          data: { usedCount: { increment: 1 } },
        });
      }
    } catch (err) {
      console.error('Error fetching feedback examples:', err);
    }
  }

  return {
    context,
    warnings,
    latestInboundMessageId: latestInbound?.id || null,
    contextRefreshedAt,
  };
}
