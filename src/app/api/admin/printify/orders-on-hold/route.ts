/**
 * Orders On Hold API
 * Lists Printify orders that are on hold with reason "multiple orders"
 */

import { NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { PrintifyClient, type PrintifyOrder } from '@/lib/printify';

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'CHANGE_STATUS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Find orders on hold from cache
    const cachedOrders = await prisma.printifyOrderCache.findMany({
      where: {
        status: 'on-hold',
      },
      orderBy: { createdAt: 'desc' },
    });

    // Filter and format orders
    const ordersOnHold = cachedOrders
      .map((cached) => {
        const data = cached.data as unknown as PrintifyOrder;

        // Check if any line item has "multiple orders" reason or similar
        const hasMultipleOrdersReason = data.line_items.some((li) => {
          const status = li.status?.toLowerCase();
          return status === 'on-hold';
        });

        if (!hasMultipleOrdersReason && data.status !== 'on-hold') {
          return null;
        }

        return {
          id: cached.id,
          printifyId: data.id,
          externalId: cached.externalId || data.external_id,
          label: cached.label || data.label,
          status: cached.status || data.status,
          customerName: `${data.address_to.first_name || ''} ${data.address_to.last_name || ''}`.trim(),
          customerEmail: data.address_to.email,
          address: data.address_to,
          createdAt: cached.createdAt.toISOString(),
          itemCount: data.line_items.reduce((sum, li) => sum + li.quantity, 0),
          items: data.line_items.map((li) => ({
            title: li.metadata?.title || 'Unknown Item',
            quantity: li.quantity,
            sku: li.metadata?.sku,
            status: li.status,
          })),
          canCancel: PrintifyClient.canCancelOrder(data),
          totalPrice: data.total_price,
        };
      })
      .filter(Boolean);

    // Group orders by customer email for easy combining
    const groupedByCustomer: Record<string, typeof ordersOnHold> = {};
    for (const order of ordersOnHold) {
      if (!order) continue;
      const email = order.customerEmail || 'unknown';
      if (!groupedByCustomer[email]) {
        groupedByCustomer[email] = [];
      }
      groupedByCustomer[email].push(order);
    }

    // Find customers with multiple orders (potential combine candidates)
    const combineCandidates = Object.entries(groupedByCustomer)
      .filter(([, orders]) => orders.length > 1)
      .map(([email, orders]) => ({
        customerEmail: email,
        customerName: orders[0]?.customerName || 'Unknown',
        orderCount: orders.length,
        orders: orders,
      }));

    return NextResponse.json({
      orders: ordersOnHold,
      combineCandidates,
      totalOnHold: ordersOnHold.length,
      customersWithMultiple: combineCandidates.length,
    });
  } catch (err) {
    console.error('Error fetching orders on hold:', err);
    return NextResponse.json(
      { error: 'Failed to fetch orders' },
      { status: 500 }
    );
  }
}
