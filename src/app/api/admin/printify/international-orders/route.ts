/**
 * International Orders API
 * Identifies Printify orders routed to domestic US print providers
 * but shipping to international addresses
 */

import { NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { PrintifyClient, type PrintifyOrder } from '@/lib/printify';

// Domestic US print provider - should NOT be used for international orders
const DOMESTIC_PRINT_PROVIDERS = [
  'Monster Digital',
];

// Countries that are considered "domestic" (US-based fulfillment is fine)
const DOMESTIC_COUNTRIES = ['US', 'USA', 'United States', 'United States of America'];

interface InternationalOrderData {
  id: string;
  printifyId: string;
  externalId?: string;
  label?: string;
  status: string;
  customerName: string;
  customerEmail?: string;
  country: string;
  address: {
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    country?: string;
    region?: string;
    address1?: string;
    address2?: string;
    city?: string;
    zip?: string;
  };
  createdAt: string;
  itemCount: number;
  items: {
    title: string;
    variant?: string;
    quantity: number;
    sku?: string;
    printProvider?: string;
    blueprintId?: number;
    variantId?: number;
  }[];
  printProviders: string[];
  canReroute: boolean;
  totalPrice: number;
}

function isDomesticPrintProvider(providerName: string): boolean {
  return DOMESTIC_PRINT_PROVIDERS.some((domestic) =>
    providerName.toLowerCase().includes(domestic.toLowerCase())
  );
}

function isInternationalCountry(country?: string): boolean {
  if (!country) return false;
  const normalized = country.toUpperCase().trim();
  return !DOMESTIC_COUNTRIES.some(
    (domestic) => domestic.toUpperCase() === normalized
  );
}

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

    // Filter for international orders with domestic print providers
    const internationalOrders: InternationalOrderData[] = [];

    for (const cached of cachedOrders) {
      const data = cached.data as unknown as PrintifyOrder;
      const country = data.address_to?.country;

      // Skip if not international
      if (!isInternationalCountry(country)) {
        continue;
      }

      // Check print providers on line items
      const printProviders: string[] = [];
      let hasDomesticProvider = false;

      for (const li of data.line_items) {
        const providerName = li.metadata?.print_provider || '';
        if (providerName) {
          printProviders.push(providerName);
          if (isDomesticPrintProvider(providerName)) {
            hasDomesticProvider = true;
          }
        }
      }

      // Skip if no domestic provider assigned
      if (!hasDomesticProvider) {
        continue;
      }

      // Get the order number
      const orderLabel = cached.label || data.label;
      const orderExternalId = cached.externalId || data.external_id;
      const metadataOrderId = data.metadata?.shop_order_id || data.metadata?.shop_order_label;
      const orderNumber = orderLabel || orderExternalId || metadataOrderId;

      internationalOrders.push({
        id: cached.id,
        printifyId: data.id,
        externalId: orderNumber,
        label: orderLabel,
        status: cached.status || data.status,
        customerName: `${data.address_to.first_name || ''} ${data.address_to.last_name || ''}`.trim(),
        customerEmail: data.address_to.email,
        country: country || 'Unknown',
        address: data.address_to,
        createdAt: cached.createdAt.toISOString(),
        itemCount: data.line_items.reduce((sum, li) => sum + li.quantity, 0),
        items: data.line_items.map((li) => ({
          title: li.metadata?.title || 'Unknown Item',
          variant: li.metadata?.variant_label,
          quantity: li.quantity,
          sku: li.metadata?.sku,
          printProvider: li.metadata?.print_provider,
          blueprintId: li.blueprint_id,
          variantId: li.variant_id,
        })),
        printProviders: [...new Set(printProviders)],
        canReroute: PrintifyClient.canCancelOrder(data),
        totalPrice: data.total_price,
      });
    }

    // Group by country for display
    const byCountry: Record<string, InternationalOrderData[]> = {};
    for (const order of internationalOrders) {
      if (!byCountry[order.country]) {
        byCountry[order.country] = [];
      }
      byCountry[order.country].push(order);
    }

    return NextResponse.json({
      orders: internationalOrders,
      byCountry,
      totalCount: internationalOrders.length,
      countriesAffected: Object.keys(byCountry).length,
    });
  } catch (err) {
    console.error('Error fetching international orders:', err);
    return NextResponse.json(
      { error: 'Failed to fetch orders' },
      { status: 500 }
    );
  }
}
