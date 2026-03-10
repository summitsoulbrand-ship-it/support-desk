/**
 * Thread context API - Get Shopify customer and Printify order data
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { createShopifyClient } from '@/lib/shopify';
import { PrintifyClient, type PrintifyOrder, type PrintifyConfig } from '@/lib/printify';
import { decryptJson } from '@/lib/encryption';

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
      customerMatchMethod?: 'email' | 'name' | 'order_name';
      cached?: boolean;
    } = {};

    const latestInbound = await prisma.message.findFirst({
      where: { threadId: thread.id, direction: 'INBOUND', fromName: { not: null } },
      orderBy: { sentAt: 'desc' },
      select: { fromName: true },
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
        // Use cache if fresh
        let usedCache = false;
        if (cachedCustomer?.shopifyData && cacheAge < cacheMaxAge) {
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
        }

        const cacheMissingOrders = usedCache && response.orders === undefined;

        if (!usedCache || cacheMissingOrders) {
          // Fetch fresh data
          const customerData = await shopifyClient.getCustomerWithOrders(
            thread.customerEmail,
            10
          );

          if (customerData) {
            response.customer = customerData.customer;
            response.orders = customerData.orders;
            response.customerMatchMethod = 'email';

            // Update cache
            await prisma.customerLink.upsert({
              where: { email: thread.customerEmail },
              create: {
                email: thread.customerEmail,
                shopifyCustomerId: customerData.customer.id,
                shopifyData: JSON.parse(
                  JSON.stringify({
                    customer: customerData.customer,
                    orders: customerData.orders,
                  })
                ),
                lastVerifiedAt: new Date(),
              },
              update: {
                shopifyCustomerId: customerData.customer.id,
                shopifyData: JSON.parse(
                  JSON.stringify({
                    customer: customerData.customer,
                    orders: customerData.orders,
                  })
                ),
                lastVerifiedAt: new Date(),
              },
            });
          }
        }
      } catch (err) {
        console.error('Error fetching Shopify data:', err);
      }
    }

    // Fallback: try matching by customer name when email doesn't match a Shopify customer
    // Require a proper name: at least 2 words, each word at least 2 chars
    const nameParts = inferredName?.trim().split(/\s+/).filter(p => p.length >= 2) || [];
    const hasValidName = nameParts.length >= 2 && nameParts.join(' ').length >= 5;

    if (
      shopifyClient &&
      !response.customer &&
      hasValidName
    ) {
      try {
        const nameMatch = await shopifyClient.findCustomerByName(inferredName!);
        if (nameMatch) {
          // Verify the matched customer name actually resembles the search name
          const matchedName = nameMatch.displayName?.toLowerCase() ||
            `${nameMatch.firstName || ''} ${nameMatch.lastName || ''}`.toLowerCase().trim();
          const searchName = inferredName!.toLowerCase().trim();

          // Check if at least one name part matches EXACTLY (not just prefix)
          // This prevents "kenny" matching "ken" or vice versa
          const matchedParts = matchedName.split(/\s+/);
          const searchParts = searchName.split(/\s+/);
          const hasExactPartMatch = searchParts.some(sp =>
            sp.length >= 2 && matchedParts.some(mp => mp === sp)
          );

          if (hasExactPartMatch) {
            const orders = await shopifyClient.getCustomerOrders(nameMatch.id, 10);
            if (orders.length > 0) {
              response.customer = nameMatch;
              response.orders = orders;
              response.customerMatchMethod = 'name';
            }
          }
        }
      } catch (err) {
        console.error('Error fetching Shopify data by name:', err);
      }
    }

    // Fallback: search orders by customer name (guest checkouts)
    // Use the same strict name validation
    if (
      shopifyClient &&
      (!response.orders || response.orders.length === 0) &&
      hasValidName
    ) {
      try {
        const cleanedName = inferredName!.trim().replace(/\s+/g, ' ');
        const normalizedTarget = cleanedName.toLowerCase();
        const exactQuery = `"${cleanedName.replace(/"/g, '\\"')}"`;
        let orders = await shopifyClient.getOrdersByQuery(exactQuery, 50);
        if (orders.length === 0) {
          orders = await shopifyClient.getOrdersByQuery(cleanedName, 50);
        }

        const matchesName = (value?: string | null) => {
          if (!value) return false;
          return value.trim().toLowerCase() === normalizedTarget;
        };

        const filtered = orders.filter((order) => {
          const shippingName = [
            order.shippingAddress?.firstName,
            order.shippingAddress?.lastName,
          ]
            .filter(Boolean)
            .join(' ')
            .trim();
          const billingName = [
            order.billingAddress?.firstName,
            order.billingAddress?.lastName,
          ]
            .filter(Boolean)
            .join(' ')
            .trim();

          return (
            matchesName(shippingName) ||
            matchesName(order.shippingAddress?.name) ||
            matchesName(billingName) ||
            matchesName(order.billingAddress?.name)
          );
        });

        let finalMatches = filtered;

        if (finalMatches.length === 0) {
          const parts = cleanedName.split(' ').filter(Boolean);
          const firstName = parts[0];
          const lastName = parts.slice(1).join(' ');
          if (firstName && lastName) {
            const nameQuery = `first_name:\"${firstName.replace(/\"/g, '\\\"')}\" last_name:\"${lastName.replace(/\"/g, '\\\"')}\"`;
            const nameOrders = await shopifyClient.getOrdersByQuery(nameQuery, 50);
            finalMatches = nameOrders.filter((order) => {
              const shippingName = [
                order.shippingAddress?.firstName,
                order.shippingAddress?.lastName,
              ]
                .filter(Boolean)
                .join(' ')
                .trim();
              const billingName = [
                order.billingAddress?.firstName,
                order.billingAddress?.lastName,
              ]
                .filter(Boolean)
                .join(' ')
                .trim();
              return (
                matchesName(shippingName) ||
                matchesName(order.shippingAddress?.name) ||
                matchesName(billingName) ||
                matchesName(order.billingAddress?.name)
              );
            });
          }
        }

        if (finalMatches.length > 0) {
          response.orders = finalMatches;
          if (!response.customerMatchMethod) {
            response.customerMatchMethod = 'order_name';
          }
        }
      } catch (err) {
        console.error('Error fetching Shopify orders by name:', err);
      }
    }

    // If no customer match, fall back to orders by email (guest checkouts)
    if (shopifyClient && (!response.orders || response.orders.length === 0)) {
      try {
        const emailOrders = await shopifyClient.getOrdersByEmail(
          thread.customerEmail,
          10
        );

        if (emailOrders.length > 0) {
          response.orders = emailOrders;
          if (!response.customerMatchMethod) {
            response.customerMatchMethod = 'email';
          }

          await prisma.customerLink.upsert({
            where: { email: thread.customerEmail },
            create: {
              email: thread.customerEmail,
              shopifyData: JSON.parse(
                JSON.stringify({
                  orders: emailOrders,
                })
              ),
              lastVerifiedAt: new Date(),
            },
            update: {
              shopifyData: JSON.parse(
                JSON.stringify({
                  orders: emailOrders,
                })
              ),
              lastVerifiedAt: new Date(),
            },
          });
        }
      } catch (err) {
        console.error('Error fetching Shopify orders by email:', err);
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
        for (const order of response.orders as any[]) {
          const candidates = [
            order.name,
            order.name?.replace('#', ''),
            order.orderNumber?.toString(),
            order.id?.replace('gid://shopify/Order/', ''),
          ].filter(Boolean);

          const cachedOrder =
            (await prisma.printifyOrderCache.findFirst({
              where: {
                OR: [
                  { externalId: { in: candidates } },
                  { label: { in: candidates } },
                  { metadataShopOrderId: { in: candidates } },
                  { metadataShopOrderLabel: { in: candidates } },
                ],
              },
              orderBy: { updatedAt: 'desc' },
            })) || null;

          if (cachedOrder?.data) {
            const orderData = cachedOrder.data as unknown as PrintifyOrder;
            printifyOrders.push({
              shopifyOrderId: order.id,
              order: orderData,
              matchMethod: 'cache',
              matchConfidence: 0.9,
              productionStatus: PrintifyClient.getProductionStatus(orderData),
            });

            await prisma.orderLink.upsert({
              where: { shopifyOrderId: order.id },
              create: {
                shopifyOrderId: order.id,
                shopifyOrderNumber: order.name,
                printifyOrderId: cachedOrder.id,
                matchMethod: 'ORDER_NUMBER' as never,
                matchConfidence: 0.9,
                printifyData: JSON.parse(JSON.stringify(orderData)),
                lastSyncAt: new Date(),
              },
              update: {
                printifyOrderId: cachedOrder.id,
                matchMethod: 'ORDER_NUMBER' as never,
                matchConfidence: 0.9,
                printifyData: JSON.parse(JSON.stringify(orderData)),
                lastSyncAt: new Date(),
              },
            });
          }
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
