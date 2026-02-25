/**
 * Printify Insights API - Analytics and metrics for Printify orders
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { PrintifyOrder } from '@/lib/printify/types';

type DateRange = {
  start: Date;
  end: Date;
};

type TimeMetrics = {
  avgQueueTime: number | null;
  avgProductionTime: number | null;
  avgFulfillmentDelay: number | null;
  avgTransitTime: number | null;
  avgTotalTime: number | null;
};

type ProviderStats = {
  providerId: number;
  orderCount: number;
  avgProductionTime: number | null;
  avgTotalTime: number | null;
};

type DelayedOrder = {
  id: string;
  appOrderId: string | null;
  externalId: string | null;
  status: string;
  createdAt: string;
  daysOld: number;
  delayReason: string;
  lastUpdate: string | null;
  isRefunded: boolean;
  isReturned: boolean;
};

type DeliveredOrder = {
  id: string;
  appOrderId: string | null;
  externalId: string | null;
  fulfilledAt: string;
  deliveredAt: string;
  deliveryDays: number; // fulfilled_at -> delivered_at
  isReturned: boolean;
};

type DailyMetric = {
  date: string;
  ordersCreated: number;
  ordersShipped: number;
  ordersDelivered: number;
  avgProductionDays: number | null;
};

function daysBetween(date1: Date, date2: Date): number {
  return Math.floor((date2.getTime() - date1.getTime()) / (1000 * 60 * 60 * 24));
}

function parseDate(dateStr: string | undefined | null): Date | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? null : d;
}

function calculateTimeMetrics(orders: PrintifyOrder[]): TimeMetrics {
  const queueTimes: number[] = [];
  const productionTimes: number[] = [];
  const fulfillmentDelays: number[] = [];
  const transitTimes: number[] = [];
  const totalTimes: number[] = [];

  for (const order of orders) {
    const createdAt = parseDate(order.created_at);
    if (!createdAt) continue;

    // Get production start - prefer order-level, fall back to line items
    let earliestProduction = parseDate(order.sent_to_production_at);
    if (!earliestProduction) {
      const productionDates = order.line_items
        .map((li) => parseDate(li.sent_to_production_at))
        .filter((d): d is Date => d !== null);
      earliestProduction = productionDates.length > 0
        ? new Date(Math.min(...productionDates.map((d) => d.getTime())))
        : null;
    }

    // Get fulfilled date - prefer order-level, fall back to line items
    let latestFulfilled = parseDate(order.fulfilled_at);
    if (!latestFulfilled) {
      const fulfilledDates = order.line_items
        .map((li) => parseDate(li.fulfilled_at))
        .filter((d): d is Date => d !== null);
      latestFulfilled = fulfilledDates.length > 0
        ? new Date(Math.max(...fulfilledDates.map((d) => d.getTime())))
        : null;
    }

    // Get shipped and delivered from shipments
    // Note: shipped_at is often not provided by Printify, so we use fulfilled_at as fallback
    const shippedDates = (order.shipments || [])
      .map((s) => parseDate(s.shipped_at))
      .filter((d): d is Date => d !== null);
    const deliveredDates = (order.shipments || [])
      .map((s) => parseDate(s.delivered_at))
      .filter((d): d is Date => d !== null);

    // Use shipped_at if available, otherwise use fulfilled_at as proxy
    const earliestShipped = shippedDates.length > 0
      ? new Date(Math.min(...shippedDates.map((d) => d.getTime())))
      : latestFulfilled; // Use fulfilled date as shipped date fallback
    const latestDelivered = deliveredDates.length > 0
      ? new Date(Math.max(...deliveredDates.map((d) => d.getTime())))
      : null;

    // Queue time: created -> production start
    if (earliestProduction) {
      queueTimes.push(daysBetween(createdAt, earliestProduction));
    }

    // Production time: production start -> fulfilled
    if (earliestProduction && latestFulfilled) {
      productionTimes.push(daysBetween(earliestProduction, latestFulfilled));
    }

    // Fulfillment delay: fulfilled -> shipped (only if we have actual shipped_at)
    if (latestFulfilled && shippedDates.length > 0) {
      const actualShipped = new Date(Math.min(...shippedDates.map((d) => d.getTime())));
      fulfillmentDelays.push(daysBetween(latestFulfilled, actualShipped));
    }

    // Transit time: shipped -> delivered
    if (earliestShipped && latestDelivered) {
      transitTimes.push(daysBetween(earliestShipped, latestDelivered));
    }

    // Total time: created -> delivered
    if (latestDelivered) {
      totalTimes.push(daysBetween(createdAt, latestDelivered));
    }
  }

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  return {
    avgQueueTime: avg(queueTimes),
    avgProductionTime: avg(productionTimes),
    avgFulfillmentDelay: avg(fulfillmentDelays),
    avgTransitTime: avg(transitTimes),
    avgTotalTime: avg(totalTimes),
  };
}

function calculateProviderStats(orders: PrintifyOrder[]): ProviderStats[] {
  const providerData: Map<number, { orders: PrintifyOrder[]; productionTimes: number[]; totalTimes: number[] }> = new Map();

  for (const order of orders) {
    const createdAt = parseDate(order.created_at);
    if (!createdAt) continue;

    for (const item of order.line_items) {
      const providerId = item.print_provider_id;
      if (!providerData.has(providerId)) {
        providerData.set(providerId, { orders: [], productionTimes: [], totalTimes: [] });
      }

      const data = providerData.get(providerId)!;
      if (!data.orders.includes(order)) {
        data.orders.push(order);
      }

      // Calculate production time for this item
      const productionStart = parseDate(item.sent_to_production_at);
      const fulfilled = parseDate(item.fulfilled_at);
      if (productionStart && fulfilled) {
        data.productionTimes.push(daysBetween(productionStart, fulfilled));
      }

      // Calculate total time if delivered
      const deliveredDates = (order.shipments || [])
        .map((s) => parseDate(s.delivered_at))
        .filter((d): d is Date => d !== null);
      if (deliveredDates.length > 0) {
        const latestDelivered = new Date(Math.max(...deliveredDates.map((d) => d.getTime())));
        data.totalTimes.push(daysBetween(createdAt, latestDelivered));
      }
    }
  }

  const stats: ProviderStats[] = [];
  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  for (const [providerId, data] of providerData.entries()) {
    stats.push({
      providerId,
      orderCount: data.orders.length,
      avgProductionTime: avg(data.productionTimes),
      avgTotalTime: avg(data.totalTimes),
    });
  }

  return stats.sort((a, b) => b.orderCount - a.orderCount);
}

function isOrderReturned(order: PrintifyOrder): boolean {
  const status = order.status.toLowerCase();
  // Check order status for return indicators
  if (status.includes('return') || status === 'rts' || status === 'returned') {
    return true;
  }
  // Check line item statuses
  return order.line_items.some((li) => {
    const liStatus = li.status.toLowerCase();
    return liStatus.includes('return') || liStatus === 'rts' || liStatus === 'returned';
  });
}

function findDelayedOrders(orders: PrintifyOrder[]): DelayedOrder[] {
  const now = new Date();
  const delayed: DelayedOrder[] = [];
  const DELAY_THRESHOLD_DAYS = 13;

  for (const order of orders) {
    const createdAt = parseDate(order.created_at);
    if (!createdAt) continue;

    const daysOld = daysBetween(createdAt, now);
    const status = order.status;

    // Skip cancelled orders
    if (status === 'cancelled' || status === 'canceled') continue;

    const shipments = order.shipments || [];

    // Skip if delivered
    const deliveredDates = shipments
      .map((s) => parseDate(s.delivered_at))
      .filter((d): d is Date => d !== null);
    const isDelivered = deliveredDates.length > 0;
    if (isDelivered) continue;

    // Delayed = created more than 13 days ago AND not shipped/delivered
    if (daysOld >= DELAY_THRESHOLD_DAYS) {
      // Check if order has been refunded (order status or any line item cancelled)
      const isRefunded =
        status === 'refunded' ||
        order.line_items.some((li) =>
          li.status === 'cancelled' || li.status === 'canceled' || li.status === 'refunded'
        );

      delayed.push({
        id: order.id,
        appOrderId: order.app_order_id || null,
        externalId: order.external_id || null,
        status,
        createdAt: order.created_at,
        daysOld,
        delayReason: `Not delivered after ${daysOld} days`,
        lastUpdate: order.updated_at || null,
        isRefunded,
        isReturned: isOrderReturned(order),
      });
    }
  }

  return delayed.sort((a, b) => b.daysOld - a.daysOld);
}

function findRecentlyDeliveredOrders(orders: PrintifyOrder[], limit: number = 10): DeliveredOrder[] {
  const delivered: DeliveredOrder[] = [];

  for (const order of orders) {
    const status = order.status;
    // Skip cancelled orders
    if (status === 'cancelled' || status === 'canceled') continue;

    // Get fulfilled_at
    const fulfilledAt = parseDate(order.fulfilled_at);
    if (!fulfilledAt) continue;

    // Get delivered date from shipments
    const shipments = order.shipments || [];
    const deliveredDates = shipments
      .map((s) => parseDate(s.delivered_at))
      .filter((d): d is Date => d !== null);

    if (deliveredDates.length === 0) continue; // Not delivered yet

    const deliveredAt = new Date(Math.max(...deliveredDates.map((d) => d.getTime())));
    const deliveryDays = daysBetween(fulfilledAt, deliveredAt);

    delivered.push({
      id: order.id,
      appOrderId: order.app_order_id || null,
      externalId: order.external_id || null,
      fulfilledAt: fulfilledAt.toISOString(),
      deliveredAt: deliveredAt.toISOString(),
      deliveryDays,
      isReturned: isOrderReturned(order),
    });
  }

  // Sort by delivered date descending (most recent first) and limit
  return delivered
    .sort((a, b) => new Date(b.deliveredAt).getTime() - new Date(a.deliveredAt).getTime())
    .slice(0, limit);
}

function calculateDailyMetrics(orders: PrintifyOrder[], range: DateRange): DailyMetric[] {
  const dailyData: Map<string, { created: number; shipped: number; delivered: number; productionDays: number[] }> = new Map();

  // Initialize all days in range
  const currentDate = new Date(range.start);
  while (currentDate <= range.end) {
    const dateKey = currentDate.toISOString().split('T')[0];
    dailyData.set(dateKey, { created: 0, shipped: 0, delivered: 0, productionDays: [] });
    currentDate.setDate(currentDate.getDate() + 1);
  }

  for (const order of orders) {
    const createdAt = parseDate(order.created_at);
    if (!createdAt) continue;

    const createdKey = createdAt.toISOString().split('T')[0];
    if (dailyData.has(createdKey)) {
      dailyData.get(createdKey)!.created += 1;
    }

    // Track shipped dates
    for (const shipment of order.shipments || []) {
      const shippedAt = parseDate(shipment.shipped_at);
      if (shippedAt) {
        const shippedKey = shippedAt.toISOString().split('T')[0];
        if (dailyData.has(shippedKey)) {
          dailyData.get(shippedKey)!.shipped += 1;
        }
      }

      const deliveredAt = parseDate(shipment.delivered_at);
      if (deliveredAt) {
        const deliveredKey = deliveredAt.toISOString().split('T')[0];
        if (dailyData.has(deliveredKey)) {
          dailyData.get(deliveredKey)!.delivered += 1;
        }
      }
    }

    // Track production time for orders created in range
    if (dailyData.has(createdKey)) {
      const productionDates = order.line_items
        .map((li) => parseDate(li.sent_to_production_at))
        .filter((d): d is Date => d !== null);
      const fulfilledDates = order.line_items
        .map((li) => parseDate(li.fulfilled_at))
        .filter((d): d is Date => d !== null);

      if (productionDates.length > 0 && fulfilledDates.length > 0) {
        const start = new Date(Math.min(...productionDates.map((d) => d.getTime())));
        const end = new Date(Math.max(...fulfilledDates.map((d) => d.getTime())));
        dailyData.get(createdKey)!.productionDays.push(daysBetween(start, end));
      }
    }
  }

  const metrics: DailyMetric[] = [];
  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  for (const [date, data] of dailyData.entries()) {
    metrics.push({
      date,
      ordersCreated: data.created,
      ordersShipped: data.shipped,
      ordersDelivered: data.delivered,
      avgProductionDays: avg(data.productionDays),
    });
  }

  return metrics.sort((a, b) => a.date.localeCompare(b.date));
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'MANAGE_INTEGRATIONS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Parse date range from query params
    const startParam = request.nextUrl.searchParams.get('start');
    const endParam = request.nextUrl.searchParams.get('end');

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const range: DateRange = {
      start: startParam ? new Date(startParam) : thirtyDaysAgo,
      end: endParam ? new Date(endParam) : now,
    };

    // Get Printify shop ID for order URLs
    const printifySettings = await prisma.integrationSettings.findUnique({
      where: { type: 'PRINTIFY' },
    });
    let shopId: string | null = null;
    if (printifySettings?.encryptedData) {
      try {
        const { decryptJson } = await import('@/lib/encryption');
        const config = decryptJson<{ shopId?: string }>(printifySettings.encryptedData);
        shopId = config.shopId || null;
      } catch {
        // Ignore decryption errors
      }
    }

    // Fetch orders from cache
    const cachedOrders = await prisma.printifyOrderCache.findMany({
      select: { data: true },
    });

    // Parse order data
    const allOrders: PrintifyOrder[] = cachedOrders
      .map((row) => row.data as unknown as PrintifyOrder)
      .filter((order): order is PrintifyOrder => order !== null);

    // Filter orders by date range for time-based metrics
    const ordersInRange = allOrders.filter((order) => {
      const createdAt = parseDate(order.created_at);
      if (!createdAt) return false;
      return createdAt >= range.start && createdAt <= range.end;
    });

    // Calculate metrics
    const timeMetrics = calculateTimeMetrics(ordersInRange);
    const providerStats = calculateProviderStats(ordersInRange);
    const delayedOrders = findDelayedOrders(allOrders);
    const dailyMetrics = calculateDailyMetrics(allOrders, range);
    const recentlyDeliveredOrders = findRecentlyDeliveredOrders(ordersInRange, 10);

    // Calculate average production time (created_at -> fulfilled_at)
    const productionTimes: number[] = [];
    // Calculate average delivery time (fulfilled_at -> delivered_at) for delivered orders
    const deliveryTimes: number[] = [];

    for (const order of ordersInRange) {
      const createdAt = parseDate(order.created_at);
      const fulfilledAt = parseDate(order.fulfilled_at);

      // Production time: created_at -> fulfilled_at
      if (createdAt && fulfilledAt) {
        productionTimes.push(daysBetween(createdAt, fulfilledAt));
      }

      // Delivery time: fulfilled_at -> delivered_at (only for delivered orders)
      if (fulfilledAt) {
        const shipments = order.shipments || [];
        const deliveredDates = shipments
          .map((s) => parseDate(s.delivered_at))
          .filter((d): d is Date => d !== null);

        if (deliveredDates.length > 0) {
          const deliveredAt = new Date(Math.max(...deliveredDates.map((d) => d.getTime())));
          deliveryTimes.push(daysBetween(fulfilledAt, deliveredAt));
        }
      }
    }

    const avgProductionTime = productionTimes.length > 0
      ? productionTimes.reduce((a, b) => a + b, 0) / productionTimes.length
      : null;
    const avgDeliveredIn = deliveryTimes.length > 0
      ? deliveryTimes.reduce((a, b) => a + b, 0) / deliveryTimes.length
      : null;

    // Summary stats - mutually exclusive categories
    const totalOrders = ordersInRange.length;

    // Delivered: All shipments have delivered_at (or order is fulfilled/archived)
    const deliveredOrders = ordersInRange.filter((o) => {
      const shipments = o.shipments || [];
      if (shipments.length === 0) return o.status === 'fulfilled' || o.status === 'archived';
      return shipments.length > 0 && shipments.every((s) => s.delivered_at);
    }).length;

    // In Transit: Has shipped (fulfilled_at exists) but not fully delivered
    const inTransitOrders = ordersInRange.filter((o) => {
      const shipments = o.shipments || [];
      const hasShipped = o.fulfilled_at || (shipments.length > 0 && shipments.some((s) => s.number));
      if (!hasShipped) return false;
      const allDelivered = shipments.length > 0 && shipments.every((s) => s.delivered_at);
      return !allDelivered;
    }).length;

    // In Production: Not shipped yet (no fulfilled_at), actively being made
    const inProductionOrders = ordersInRange.filter((o) => {
      // If order has fulfilled_at, it's already shipped
      if (o.fulfilled_at) return false;

      const shipments = o.shipments || [];
      const hasShipped = shipments.length > 0 && shipments.some((s) => s.number);
      if (hasShipped) return false; // Already shipped, not in production

      // Check order or line item status
      const productionStatuses = ['in-production', 'sending-to-production', 'checking-quality'];
      return productionStatuses.includes(o.status) ||
        o.line_items.some((li) => productionStatuses.includes(li.status));
    }).length;

    return NextResponse.json({
      shopId,
      range: {
        start: range.start.toISOString(),
        end: range.end.toISOString(),
      },
      summary: {
        totalOrders,
        deliveredOrders,
        inTransitOrders,
        inProductionOrders,
        deliveryRate: totalOrders > 0 ? deliveredOrders / totalOrders : 0,
        avgProductionTime,
        avgDeliveredIn,
      },
      timeMetrics,
      providerStats,
      delayedOrders,
      recentlyDeliveredOrders,
      dailyMetrics,
    });
  } catch (err) {
    console.error('Error fetching Printify insights:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
