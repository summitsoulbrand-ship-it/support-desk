/**
 * Claude suggestion API - Generate suggested reply drafts
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { createClaudeService } from '@/lib/claude';
import {
  SuggestionContext,
  MessageContext,
  buildShopifyContext,
  buildPrintifyContext,
  buildTrackingContext,
} from '@/lib/claude/types';
import { ShopifyCustomer, ShopifyOrder } from '@/lib/shopify/types';
import { type PrintifyOrder } from '@/lib/printify';
import { type TrackingResult } from '@/lib/trackingmore';

type RouteContext = {
  params: Promise<{ id: string }>;
};

type MatchMethod = 'email' | 'order_number' | 'name' | 'cache';

interface OrderMatchResult {
  customer: ShopifyCustomer | null;
  orders: ShopifyOrder[];
  matchMethod: MatchMethod;
}

/**
 * Get cached customer/order data from database
 * This is MUCH faster than making live Shopify API calls
 */
async function getCachedOrderContext(
  email: string
): Promise<OrderMatchResult | null> {
  const cached = await prisma.customerLink.findUnique({
    where: { email },
  });

  if (!cached?.shopifyData) {
    return null;
  }

  const data = cached.shopifyData as {
    customer?: ShopifyCustomer;
    orders?: ShopifyOrder[];
  };

  // Only use cache if we have orders (that's what we need for suggestions)
  if (!data.orders || data.orders.length === 0) {
    return null;
  }

  return {
    customer: data.customer || null,
    orders: data.orders,
    matchMethod: 'cache',
  };
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'REPLY_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;

    // Parse optional refinement parameters from request body
    let currentDraft: string | undefined;
    let refinementInstructions: string | undefined;

    try {
      const contentType = request.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        const body = await request.json();
        currentDraft = body.currentDraft;
        refinementInstructions = body.instructions;
      }
    } catch {
      // No body or invalid JSON - proceed without refinement
    }

    // Get current user with signature
    const currentUser = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { name: true, signature: true },
    });

    // Get thread with messages
    const thread = await prisma.thread.findUnique({
      where: { id },
      include: {
        messages: {
          orderBy: { sentAt: 'asc' },
        },
      },
    });

    if (!thread) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    }

    // Get Claude service
    const claudeService = await createClaudeService();
    if (!claudeService) {
      return NextResponse.json(
        { error: 'Claude API not configured' },
        { status: 503 }
      );
    }

    // Build suggestion context
    const suggestionContext: SuggestionContext = {
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
      agent: currentUser
        ? {
            name: currentUser.name,
            signature: currentUser.signature || undefined,
          }
        : undefined,
    };

    if (thread.lastActionType && thread.lastActionAt) {
      suggestionContext.recentAction = {
        type: thread.lastActionType,
        at: thread.lastActionAt.toISOString(),
        data: (thread.lastActionData as Record<string, unknown> | null) || undefined,
      };
    }

    // Try to get Shopify context from CACHE first (much faster than live API calls)
    let orderMatchWarning: string | undefined;

    try {
      // First check cache - this is instant
      const matchResult = await getCachedOrderContext(thread.customerEmail);

      if (matchResult) {
        // Add warning for non-email matches
        if (matchResult.matchMethod === 'order_number') {
          orderMatchWarning = 'Order matched by order number found in email content - please verify this is the correct customer';
        } else if (matchResult.matchMethod === 'name') {
          orderMatchWarning = 'Customer matched by name only - please verify this is the correct customer';
        }

        // Build context from customer and orders
        if (matchResult.customer) {
          Object.assign(
            suggestionContext,
            buildShopifyContext(matchResult.customer, matchResult.orders)
          );
        } else if (matchResult.orders.length > 0) {
          // No customer account, but we have an order - build minimal context
          const order = matchResult.orders[0];
          suggestionContext.shopifyOrder = {
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

        // Try to get Printify context for the most recent order from cache
        if (matchResult.orders.length > 0) {
          const order = matchResult.orders[0];
          const candidates = [
            order.name,
            order.name?.replace('#', ''),
            order.orderNumber?.toString(),
            order.id?.replace('gid://shopify/Order/', ''),
          ].filter(Boolean);

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

          if (cachedOrder?.data) {
            const orderData = cachedOrder.data as unknown as PrintifyOrder;
            Object.assign(
              suggestionContext,
              buildPrintifyContext(orderData)
            );

            // Try to get cached tracking data for the shipment
            if (orderData.shipments?.length > 0) {
              const shipment = orderData.shipments[0];
              if (shipment.number && shipment.carrier) {
                const cachedTracking = await prisma.trackingCache.findUnique({
                  where: {
                    trackingNumber_carrier: {
                      trackingNumber: shipment.number,
                      carrier: shipment.carrier,
                    },
                  },
                });

                if (cachedTracking?.data) {
                  const trackingData = cachedTracking.data as unknown as TrackingResult;
                  Object.assign(
                    suggestionContext,
                    buildTrackingContext(trackingData, orderData)
                  );
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('Error fetching order context:', err);
      // Continue without context
    }

    // Fetch relevant feedback examples for few-shot learning
    try {
      // Get current thread tags
      const threadTags = await prisma.threadTag.findMany({
        where: { threadId: id },
        include: { tag: true },
      });
      const tagNames = threadTags.map((tt) => tt.tag.name);

      // Find feedback with matching tags, or most recent if no matches
      let feedbackRecords;
      if (tagNames.length > 0) {
        feedbackRecords = await prisma.suggestionFeedback.findMany({
          where: {
            threadTags: { hasSome: tagNames },
          },
          orderBy: { createdAt: 'desc' },
          take: 3,
        });
      }

      // Fallback to most recent feedback if no tag matches
      if (!feedbackRecords || feedbackRecords.length === 0) {
        feedbackRecords = await prisma.suggestionFeedback.findMany({
          orderBy: { createdAt: 'desc' },
          take: 3,
        });
      }

      if (feedbackRecords.length > 0) {
        suggestionContext.feedbackExamples = feedbackRecords.map((f) => ({
          original: f.originalDraft,
          edited: f.editedDraft,
        }));

        // Update usage count for these feedback records
        await prisma.suggestionFeedback.updateMany({
          where: { id: { in: feedbackRecords.map((f) => f.id) } },
          data: { usedCount: { increment: 1 } },
        });
      }
    } catch (feedbackErr) {
      console.error('Error fetching feedback examples:', feedbackErr);
      // Continue without feedback
    }

    // Add refinement context if provided
    if (currentDraft && refinementInstructions) {
      suggestionContext.refinement = {
        currentDraft,
        instructions: refinementInstructions,
      };
    }

    // Generate suggestion
    const suggestion = await claudeService.generateSuggestion(suggestionContext);

    // Add match warning to response if applicable
    if (orderMatchWarning) {
      suggestion.warnings = suggestion.warnings || [];
      suggestion.warnings.unshift(orderMatchWarning);
    }

    return NextResponse.json(suggestion);
  } catch (err) {
    console.error('Error generating suggestion:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `Failed to generate suggestion: ${message}` },
      { status: 500 }
    );
  }
}
