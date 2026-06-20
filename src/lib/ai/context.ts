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
  formatAddressLine,
  billingIfDiffers,
} from '@/lib/claude/types';
import { ShopifyCustomer, ShopifyOrder } from '@/lib/shopify/types';
import { createShopifyClient } from '@/lib/shopify';
import { findOrdersByName } from '@/lib/shopify/name-match';
import { resolveReceiptOrder } from '@/lib/ai/receipt-extract';
import { createPrintifyClient, PrintifyClient, type PrintifyOrder } from '@/lib/printify';
import { createTrackingMoreClient, type TrackingResult } from '@/lib/trackingmore';
import { getKnowledgeBlocks } from '@/lib/knowledge';
import { fetchDhlLiveTracking } from '@/lib/tracking/dhl';
import { matchOrderForRequest, sizesEquivalent } from '@/lib/ai/order-match';

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

interface CustomerOrders {
  customer: ShopifyCustomer | null;
  orders: ShopifyOrder[];
  /** True when orders were found by NAME, not email - unverified, flag it */
  matchedByNameOnly?: boolean;
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

async function getFreshCustomerOrders(
  email: string,
  inferredName?: string | null
): Promise<CustomerOrders | null> {
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

  // Email matched nothing? Fall back to NAME matching (same logic the sidebar
  // uses) so the draft sees the order the operator sees. Marked unverified.
  if (!result && inferredName) {
    const byName = await findOrdersByName(shopifyClient, inferredName);
    if (byName) {
      result = {
        customer: byName.customer,
        orders: byName.orders,
        matchedByNameOnly: true,
      };
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
 * Few-shot feedback examples are whole past replies meant to teach TONE only.
 * They contain real order numbers, addresses, tracking links, dates and names
 * from OTHER customers' threads - if left raw, the model copies those specifics
 * into an unrelated reply (fabricating wrong details AND leaking another
 * customer's PII). Redact the copyable specifics so only the style remains.
 */
function scrubExample(text: string): string {
  if (!text) return text;
  return text
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/gi, '[email]')
    .replace(/#\s?\d{3,}/g, '#[order]')
    .replace(
      /\b\d{1,6}\s+[A-Za-z0-9.\s]{2,40}?\s(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|way|circle|cir|place|pl|terrace|ter|highway|hwy)\b\.?/gi,
      '[address]'
    )
    .replace(/\b\d{5}(?:-\d{4})?\b/g, '[zip]')
    .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[phone]')
    .replace(
      /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?\b/gi,
      '[date]'
    )
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, '[date]')
    .replace(/\b(Hi|Hello|Hey|Dear)\s+[A-Z][a-zA-Z]+\b/g, '$1 [name]');
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
        const inferredName = thread.customerName || latestInbound?.fromName || null;
        match = await getFreshCustomerOrders(thread.customerEmail, inferredName);
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

  // Last resort: no order found by email or name, but the customer attached a
  // receipt. Read the order number off it (cached on the triage row) and look
  // it up. Shared with the sidebar context route.
  if (!match && forceFresh && latestInbound) {
    try {
      const receiptMatch = await resolveReceiptOrder({
        threadId: thread.id,
        latestInboundMessageId: latestInbound.id,
        triageEntities: thread.triage?.entities as Record<string, unknown> | null,
        hasTriageRow: !!thread.triage,
      });
      if (receiptMatch) {
        match = { customer: null, orders: receiptMatch.orders };
        contextRefreshedAt = new Date();
        warnings.push(
          `Order matched from the attached receipt (#${receiptMatch.orderNumber}) - the sender's email/name did not match, so verify this is the right order before any change`
        );
      }
    } catch (err) {
      console.error('Receipt order extraction failed:', err);
    }
  }

  if (match) {
    if (match.matchedByNameOnly) {
      warnings.push(
        'Order matched by NAME only (sender email did not match) - treat as unverified; confirm the order number before promising any change'
      );
    }
    // When there are multiple orders, identify which one the request is about
    // (or flag it ambiguous) and surface the full list so the model can ask.
    // Replacements that already exist - tagged Replacement with a note naming
    // the original order. Critical: without this the draft re-promises a
    // replacement the customer already has (e.g. they email again because
    // they missed the confirmation).
    const existingReplacements = match.orders.filter((o) =>
      (o.tags || []).some((t) => t.toLowerCase() === 'replacement')
    );
    if (existingReplacements.length > 0) {
      context.replacementsAlreadyCreated = existingReplacements.map((r) => ({
        replacementOrder: r.name,
        forOrder: r.note?.match(/Replacement order for (#\d+)/i)?.[1] || '',
        createdAt: r.createdAt,
        fulfillmentStatus: r.fulfillmentStatus,
        items: r.lineItems.map(
          (li) => `${li.title}${li.variantTitle ? ` - ${li.variantTitle}` : ''}`
        ),
      }));
    }

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

    // Size-exchange sanity check: the customer says they have a size that
    // isn't on any of their orders (e.g. "my L is too small" but they only
    // ever bought S and M). The premise is wrong - the draft must ask to
    // clarify, not confirm a replacement. Only fires when the customer named
    // an explicit current size (a vague "too small" carries no claim to check).
    if (thread.triage?.intent === 'SIZE_EXCHANGE' && match.orders.length > 0) {
      const entities =
        (thread.triage.entities as { currentSize?: string } | null) || {};
      const claimedSize = entities.currentSize?.trim();
      if (claimedSize) {
        const sizesOf = (order: ShopifyOrder): string[] =>
          order.lineItems
            .map(
              (li) =>
                li.selectedOptions?.find((o) =>
                  o.name.toLowerCase().includes('size')
                )?.value
            )
            .filter((v): v is string => !!v);

        const sizeOnAnyOrder = match.orders.some((o) =>
          sizesOf(o).some((s) => sizesEquivalent(s, claimedSize))
        );

        if (!sizeOnAnyOrder) {
          const primary = match.orders[0];
          context.exchangeSizeIssue = {
            claimedSize,
            orderNumber: primary.name,
            orderedSizes: [...new Set(sizesOf(primary))],
          };
          warnings.push(
            `Customer says they have size ${claimedSize}, but ${primary.name} has no ${claimedSize} (sizes: ${[...new Set(sizesOf(primary))].join(', ') || 'none'}) - the draft asks to clarify instead of confirming`
          );
        }
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
        shippingAddress: formatAddressLine(order.shippingAddress),
        billingAddressOnFile: billingIfDiffers(order),
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

          // If this is a change/exchange request AND the order hasn't been sent
          // to production yet, we can change the order itself before it prints
          // (cancel + recreate on Printify, edit the Shopify order) - no free
          // replacement, no duplicate. Tell the draft so it confirms the change
          // instead of offering a "keep the original" replacement.
          if (
            thread.triage?.intent === 'SIZE_EXCHANGE' &&
            PrintifyClient.canCancelOrder(printifyOrder)
          ) {
            context.changeBeforeProduction = { orderNumber: order.name };
          }

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
            const trackingIsFinal =
              tracking?.status === 'delivered' || tracking?.status === 'expired';

            // Metered API: live carrier fetch only when the reply actually
            // hinges on shipping state; other intents use whatever is cached
            const triageIntent = thread.triage?.intent;
            const lastInboundMsg = [...thread.messages]
              .reverse()
              .find((m) => m.direction === 'INBOUND');
            const inboundText = (lastInboundMsg?.bodyText || '').toLowerCase();
            const shippingRelevant =
              triageIntent === 'SHIPPING_STATUS' ||
              triageIntent === 'ORDER_ISSUE' ||
              /lost|never (arrived|came|got|received)|missing|where('s| is)|tracking/.test(
                inboundText
              );
            // A non-final status (in transit / out for delivery) can advance to
            // delivered within the freshness window, so for a shipping reply we
            // pull live truth regardless of cache age - only a FINAL status
            // (delivered/expired) skips the call.
            if (forceFresh && shippingRelevant && !trackingIsFinal) {
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

    // --- Live carrier check (DHL official API): ONLY for shipping-status /
    // lost-package inquiries - the carrier is the source of truth and can
    // also provide a proof-of-delivery document ---
    const intent = thread.triage?.intent;
    const lastInbound = [...thread.messages]
      .reverse()
      .find((m) => m.direction === 'INBOUND');
    const lastText = (lastInbound?.bodyText || '').toLowerCase();
    const mentionsLost =
      /lost|never (arrived|came|got|received)|missing|stolen|didn'?t (arrive|come|receive)/.test(
        lastText
      );
    const wantsLiveTracking =
      intent === 'SHIPPING_STATUS' || intent === 'ORDER_ISSUE' || mentionsLost;
    const liveTrackingNumber =
      context.trackingInfo?.trackingNumber ||
      context.shopifyOrder?.trackingNumber;
    const liveCarrier = (context.trackingInfo?.carrier || '').toLowerCase();
    if (
      wantsLiveTracking &&
      liveTrackingNumber &&
      (liveCarrier.includes('dhl') || !context.trackingInfo)
    ) {
      const live = await fetchDhlLiveTracking(liveTrackingNumber);
      if (live && live.statusCode !== 'unknown') {
        const liveStatusMap: Record<string, string> = {
          'pre-transit': 'Label created - NOT shipped yet',
          transit: 'Shipped, on the way',
          delivered: 'Delivered',
          failure: 'Delivery issue',
        };
        const hasShippedLive =
          live.statusCode === 'transit' || live.statusCode === 'delivered';

        // DHL eCommerce often scans only the FIRST leg, then hands the parcel
        // to USPS for final delivery - so DHL's own feed can sit on "in transit"
        // while USPS already delivered (Printify/TrackingMore see that via the
        // last leg). Never let DHL DOWNGRADE a status another source already
        // advanced; apply it only when it moves the status forward, or signals
        // a delivery exception worth surfacing.
        const rank = (info?: { isDelivered?: boolean; hasShipped?: boolean }) =>
          info?.isDelivered ? 4 : info?.hasShipped ? 2 : 0;
        const dhlRank =
          live.statusCode === 'delivered'
            ? 4
            : live.statusCode === 'transit'
              ? 2
              : 0;
        const isException = live.statusCode === 'failure';

        if (dhlRank >= rank(context.trackingInfo) || isException) {
          context.trackingInfo = {
            ...(context.trackingInfo || {
              carrier: 'DHL eCommerce',
              trackingNumber: liveTrackingNumber,
              isDelivered: false,
              hasShipped: false,
              status: '',
            }),
            status: `${liveStatusMap[live.statusCode] || live.statusText} (live from carrier${live.location ? `, ${live.location}` : ''})`,
            latestEvent: live.events[0]
              ? `${live.events[0].description}${live.events[0].location ? ` - ${live.events[0].location}` : ''} (${live.events[0].timestamp})`
              : context.trackingInfo?.latestEvent,
            lastUpdate: live.timestamp || context.trackingInfo?.lastUpdate,
            estimatedDelivery:
              live.estimatedDelivery || context.trackingInfo?.estimatedDelivery,
            isDelivered: live.statusCode === 'delivered',
            deliveredAt:
              live.statusCode === 'delivered' && live.timestamp
                ? new Date(live.timestamp).toLocaleString('en-US', {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })
                : context.trackingInfo?.deliveredAt,
            hasShipped: hasShippedLive,
            proofOfDeliveryUrl:
              live.proofOfDeliveryUrl || context.trackingInfo?.proofOfDeliveryUrl,
          };
        } else if (
          live.proofOfDeliveryUrl &&
          context.trackingInfo &&
          !context.trackingInfo.proofOfDeliveryUrl
        ) {
          // DHL is behind the real status but still handed us a POD doc - keep
          // the more-advanced status, just attach the proof.
          context.trackingInfo.proofOfDeliveryUrl = live.proofOfDeliveryUrl;
        }
      }
    }

    // --- Shopify's own fulfillment tracking: fills the gaps TrackingMore
    // leaves (stale cache, exhausted quota) with shipment events + the
    // estimated delivery date Shopify computes itself ---
    const matchedOrder = match.orders[0];
    if (
      matchedOrder &&
      matchedOrder.fulfillments?.length > 0 &&
      (!context.trackingInfo || !context.trackingInfo.estimatedDelivery)
    ) {
      try {
        const shopifyClient = await createShopifyClient();
        const ft = shopifyClient
          ? await shopifyClient.getOrderFulfillmentTracking(matchedOrder.id)
          : null;
        if (ft) {
          const latest = ft.events[0];
          const SHIPPED_STATUSES = new Set([
            'IN_TRANSIT',
            'OUT_FOR_DELIVERY',
            'ATTEMPTED_DELIVERY',
            'READY_FOR_PICKUP',
            'DELIVERED',
          ]);
          const statusText: Record<string, string> = {
            LABEL_PRINTED: 'Label created - NOT shipped yet',
            LABEL_PURCHASED: 'Label created - NOT shipped yet',
            CONFIRMED: 'Confirmed by carrier - not yet picked up',
            IN_TRANSIT: 'Shipped, on the way',
            OUT_FOR_DELIVERY: 'Out for delivery',
            ATTEMPTED_DELIVERY: 'Delivery attempted',
            READY_FOR_PICKUP: 'Ready for pickup',
            DELIVERED: 'Delivered',
            FAILURE: 'Delivery issue',
          };
          const eta = ft.estimatedDeliveryAt
            ? new Date(ft.estimatedDeliveryAt).toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })
            : undefined;

          if (!context.trackingInfo && latest) {
            // No TrackingMore data at all - build from Shopify alone
            context.trackingInfo = {
              status: statusText[latest.status] || latest.status,
              carrier: ft.trackingCompany || 'carrier',
              trackingNumber: ft.trackingNumber || '',
              estimatedDelivery: eta,
              lastUpdate: latest.happenedAt,
              latestEvent: `${statusText[latest.status] || latest.status} (${latest.happenedAt})`,
              isDelivered: latest.status === 'DELIVERED',
              hasShipped: SHIPPED_STATUSES.has(latest.status),
            };
          } else if (context.trackingInfo) {
            // Fill the holes in existing tracking data
            if (!context.trackingInfo.estimatedDelivery && eta) {
              context.trackingInfo.estimatedDelivery = eta;
            }
            if (latest && SHIPPED_STATUSES.has(latest.status) && !context.trackingInfo.hasShipped) {
              // Shopify saw carrier movement that the stale cache missed
              context.trackingInfo.hasShipped = true;
              context.trackingInfo.status = statusText[latest.status] || latest.status;
              context.trackingInfo.latestEvent = `${statusText[latest.status] || latest.status} (${latest.happenedAt})`;
              context.trackingInfo.isDelivered = latest.status === 'DELIVERED';
            }
          }
        }
      } catch (err) {
        console.error('Shopify fulfillment tracking fill failed:', err);
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
          original: scrubExample(f.originalDraft),
          edited: scrubExample(f.editedDraft),
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
