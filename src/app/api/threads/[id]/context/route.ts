/**
 * Thread context API - Get Shopify customer and Printify order data
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { createShopifyClient } from '@/lib/shopify';
import { resolveThreadOrders } from '@/lib/ai/order-resolve';
import { PrintifyClient, type PrintifyOrder, type PrintifyConfig } from '@/lib/printify';
import { decryptJson } from '@/lib/encryption';
import { cacheGet, cacheSet, cacheKey, CACHE_TTL } from '@/lib/cache';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;

    // Get thread
    const thread = await prisma.thread.findUnique({
      where: { id },
    });

    if (!thread) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    }

    const response: {
      thread?: { customerEmail: string; customerName: string | null };
      customer?: unknown;
      orders?: unknown[];
      printifyOrders?: unknown[];
      storeDomain?: string;
      printifyShopId?: string;
      customerMatchMethod?: 'email' | 'email_typo' | 'name' | 'order_name';
      cached?: boolean;
    } = {};

    const latestInbound = await prisma.message.findFirst({
      where: { threadId: thread.id, direction: 'INBOUND', fromName: { not: null } },
      orderBy: { sentAt: 'desc' },
      select: { id: true, fromName: true },
    });
    const inferredName = thread.customerName || latestInbound?.fromName || null;

    response.thread = {
      customerEmail: thread.customerEmail,
      customerName: inferredName,
    };

    // Check for cached customer link
    const cachedCustomer = await prisma.customerLink.findUnique({
      where: { email: thread.customerEmail },
    });

    const cacheAge = cachedCustomer?.lastVerifiedAt
      ? Date.now() - cachedCustomer.lastVerifiedAt.getTime()
      : Infinity;
    const forceFresh = request.nextUrl.searchParams.get('fresh') === '1';
    const recentReplacement =
      thread.lastActionType === 'replacement_created' &&
      thread.lastActionAt &&
      Date.now() - thread.lastActionAt.getTime() < 10 * 60 * 1000;
    const cacheMaxAge = forceFresh || recentReplacement ? 0 : 5 * 60 * 1000; // 5 minutes

    // Add integration metadata for linkouts
    const printifySettings = await prisma.integrationSettings.findUnique({
      where: { type: 'PRINTIFY' },
    });
    if (printifySettings?.enabled) {
      const config = decryptJson<PrintifyConfig>(printifySettings.encryptedData);
      response.printifyShopId = config.shopId;
    }

    // Try to get Shopify data
    const shopifyClient = await createShopifyClient();

    if (shopifyClient) {
      response.storeDomain = shopifyClient.getStoreDomain();
      try {
        let usedCache = false;
        const redisCacheKey = cacheKey.customerContext(thread.customerEmail);

        // 1. Check Redis cache first (fastest)
        if (!forceFresh && !recentReplacement) {
          const redisCache = await cacheGet<{
            customer?: unknown;
            orders?: unknown[];
          }>(redisCacheKey);

          if (redisCache) {
            response.customer = redisCache.customer;
            response.orders = redisCache.orders;
            response.cached = true;
            response.customerMatchMethod = 'email';
            usedCache = true;
          }
        }

        // 2. Check database cache if Redis miss
        if (!usedCache && cachedCustomer?.shopifyData && cacheAge < cacheMaxAge) {
          const cached =
            (cachedCustomer.shopifyData as {
              customer?: unknown;
              orders?: unknown[];
            }) || {};

          response.customer = cached.customer ?? cachedCustomer.shopifyData;
          if (Array.isArray(cached.orders)) {
            response.orders = cached.orders;
          }
          response.cached = true;
          response.customerMatchMethod = 'email';
          usedCache = true;

          // Populate Redis cache from DB cache for next request
          if (cached.customer && cached.orders) {
            cacheSet(redisCacheKey, cached, CACHE_TTL.CUSTOMER_CONTEXT);
          }
        }

        const cacheMissingOrders = usedCache && response.orders === undefined;

        // 3. Fetch fresh data from Shopify API
        if (!usedCache || cacheMissingOrders) {
          const customerData = await shopifyClient.getCustomerWithOrders(
            thread.customerEmail,
            10
          );

          if (customerData) {
            response.customer = customerData.customer;
            response.orders = customerData.orders;
            response.customerMatchMethod = 'email';

            const cacheData = {
              customer: customerData.customer,
              orders: customerData.orders,
            };

            // Update Redis cache (fire and forget)
            cacheSet(redisCacheKey, cacheData, CACHE_TTL.CUSTOMER_CONTEXT);

            // Update database cache
            await prisma.customerLink.upsert({
              where: { email: thread.customerEmail },
              create: {
                email: thread.customerEmail,
                shopifyCustomerId: customerData.customer.id,
                shopifyData: JSON.parse(JSON.stringify(cacheData)),
                lastVerifiedAt: new Date(),
              },
              update: {
                shopifyCustomerId: customerData.customer.id,
                shopifyData: JSON.parse(JSON.stringify(cacheData)),
                lastVerifiedAt: new Date(),
              },
            });
          }
        }
      } catch (err) {
        console.error('Error fetching Shopify data:', err);
      }
    }

    // Email matching found no orders: run the SAME shared cascade the AI draft
    // uses - guest-email -> name -> attached receipt -> order number in the
    // message - so the operator and the draft always resolve to the same order.
    // resolveThreadOrders isolates each step so one Shopify hiccup can't wipe
    // out the rest. (Previously this route and the draft had two separate
    // cascades that drifted, so the draft went blind on orders the sidebar
    // matched fine.)
    if (shopifyClient && (!response.orders || response.orders.length === 0)) {
      try {
        const triage = await prisma.threadTriage.findUnique({
          where: { threadId: thread.id },
          select: { entities: true },
        });
        const resolved = await resolveThreadOrders({
          shopifyClient,
          email: thread.customerEmail,
          inferredName,
          threadId: thread.id,
          latestInboundMessageId: latestInbound?.id ?? null,
          triageEntities: triage?.entities as Record<string, unknown> | null,
          hasTriageRow: !!triage,
        });
        if (resolved) {
          if (!response.customer && resolved.customer) {
            response.customer = resolved.customer;
          }
          response.orders = resolved.orders;
          if (!response.customerMatchMethod) {
            response.customerMatchMethod = resolved.method;
          }
          // Only the email-verified path is safe to cache under the email key;
          // name / receipt / order-number matches are unverified and must not
          // poison the email cache the draft reads back as trusted.
          if (resolved.method === 'email') {
            const cacheData = {
              customer: resolved.customer || undefined,
              orders: resolved.orders,
            };
            cacheSet(
              cacheKey.customerContext(thread.customerEmail),
              cacheData,
              CACHE_TTL.CUSTOMER_CONTEXT
            );
            await prisma.customerLink.upsert({
              where: { email: thread.customerEmail },
              create: {
                email: thread.customerEmail,
                shopifyCustomerId: resolved.customer?.id,
                shopifyData: JSON.parse(JSON.stringify(cacheData)),
                lastVerifiedAt: new Date(),
              },
              update: {
                shopifyCustomerId: resolved.customer?.id || undefined,
                shopifyData: JSON.parse(JSON.stringify(cacheData)),
                lastVerifiedAt: new Date(),
              },
            });
          }
        }
      } catch (err) {
        console.error('Order resolution fallback (sidebar) failed:', err);
      }
    }

    // Try to get Printify data for orders from local cache
    const hasPrintifyCache =
      (await prisma.printifyOrderCache.findFirst({
        select: { id: true },
      })) !== null;

    if (response.orders && Array.isArray(response.orders)) {
      try {
        const printifyOrders: unknown[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ordersArray = response.orders as any[];

        // Batch lookup: collect all candidates from all orders
        const allCandidates: string[] = [];
        const orderCandidatesMap = new Map<string, string[]>();

        for (const order of ordersArray) {
          const candidates = [
            order.name,
            order.name?.replace('#', ''),
            order.orderNumber?.toString(),
            order.id?.replace('gid://shopify/Order/', ''),
          ].filter(Boolean) as string[];

          orderCandidatesMap.set(order.id, candidates);
          allCandidates.push(...candidates);
        }

        // Single batch query for all Printify orders
        const cachedOrders = allCandidates.length > 0
          ? await prisma.printifyOrderCache.findMany({
              where: {
                OR: [
                  { externalId: { in: allCandidates } },
                  { label: { in: allCandidates } },
                  { metadataShopOrderId: { in: allCandidates } },
                  { metadataShopOrderLabel: { in: allCandidates } },
                ],
              },
              orderBy: { updatedAt: 'desc' },
            })
          : [];

        // Build lookup index for fast matching
        const cacheIndex = new Map<string, typeof cachedOrders[0]>();
        for (const cached of cachedOrders) {
          if (cached.externalId) cacheIndex.set(cached.externalId, cached);
          if (cached.label) cacheIndex.set(cached.label, cached);
          if (cached.metadataShopOrderId) cacheIndex.set(cached.metadataShopOrderId, cached);
          if (cached.metadataShopOrderLabel) cacheIndex.set(cached.metadataShopOrderLabel, cached);
        }

        // Match orders and collect upserts
        const orderLinksToUpsert: Array<{
          shopifyOrderId: string;
          shopifyOrderNumber: string;
          printifyOrderId: string;
          orderData: PrintifyOrder;
        }> = [];

        for (const order of ordersArray) {
          const candidates = orderCandidatesMap.get(order.id) || [];
          let cachedOrder: typeof cachedOrders[0] | undefined;

          // Find first matching cached order
          for (const candidate of candidates) {
            cachedOrder = cacheIndex.get(candidate);
            if (cachedOrder) break;
          }

          if (cachedOrder?.data) {
            const orderData = cachedOrder.data as unknown as PrintifyOrder;

            // Cached carrier status (TrackingMore) for the latest shipment, so
            // the UI badge reflects real movement, not just "has a label".
            let carrierStatus: string | undefined;
            const shipment = orderData.shipments?.[0];
            if (shipment?.number && shipment?.carrier) {
              const tc = await prisma.trackingCache.findUnique({
                where: {
                  trackingNumber_carrier: {
                    trackingNumber: shipment.number,
                    carrier: shipment.carrier,
                  },
                },
              });
              if (tc?.data) {
                carrierStatus = (tc.data as { status?: string }).status;
              }
            }

            printifyOrders.push({
              shopifyOrderId: order.id,
              order: orderData,
              matchMethod: 'cache',
              matchConfidence: 0.9,
              productionStatus: PrintifyClient.getProductionStatus(orderData),
              carrierStatus,
            });

            orderLinksToUpsert.push({
              shopifyOrderId: order.id,
              shopifyOrderNumber: order.name,
              printifyOrderId: cachedOrder.id,
              orderData,
            });
          }
        }

        // Batch upsert order links (using transaction for atomicity)
        if (orderLinksToUpsert.length > 0) {
          await prisma.$transaction(
            orderLinksToUpsert.map((link) =>
              prisma.orderLink.upsert({
                where: { shopifyOrderId: link.shopifyOrderId },
                create: {
                  shopifyOrderId: link.shopifyOrderId,
                  shopifyOrderNumber: link.shopifyOrderNumber,
                  printifyOrderId: link.printifyOrderId,
                  matchMethod: 'ORDER_NUMBER' as never,
                  matchConfidence: 0.9,
                  printifyData: JSON.parse(JSON.stringify(link.orderData)),
                  lastSyncAt: new Date(),
                },
                update: {
                  printifyOrderId: link.printifyOrderId,
                  matchMethod: 'ORDER_NUMBER' as never,
                  matchConfidence: 0.9,
                  printifyData: JSON.parse(JSON.stringify(link.orderData)),
                  lastSyncAt: new Date(),
                },
              })
            )
          );
        }

        if (printifyOrders.length > 0) {
          response.printifyOrders = printifyOrders;
        }

        if (!hasPrintifyCache) {
          // Signal that sync is needed
          (response as { printifySyncNeeded?: boolean }).printifySyncNeeded = true;
        }
      } catch (err) {
        console.error('Error fetching Printify data:', err);
      }
    }

    return NextResponse.json(response);
  } catch (err) {
    console.error('Error fetching context:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
