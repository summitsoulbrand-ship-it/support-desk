/**
 * Claude suggestion service types
 */

import { ShopifyCustomer, ShopifyOrder } from '@/lib/shopify/types';
import { PrintifyOrder } from '@/lib/printify/types';
import { TrackingResult } from '@/lib/trackingmore';

export interface ClaudeConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  projectId?: string; // Claude project ID for billing/organization
  customPrompt?: string; // Custom system prompt to override/extend default
}

export interface MessageContext {
  from: string;
  date: string;
  subject: string;
  body: string;
}

export interface SuggestionContext {
  // Thread messages (most recent last)
  messages: MessageContext[];

  // Agent info for signature
  agent?: {
    name: string;
    signature?: string;
  };

  // Customer info from Shopify
  customer?: {
    name: string;
    email: string;
    totalSpent: string;
    numberOfOrders: number;
    tags: string[];
  };

  // Most recent order context
  shopifyOrder?: {
    orderNumber: string;
    status: string;
    fulfillmentStatus: string | null;
    createdAt: string;
    totalPrice: string;
    currency: string;
    lineItems: {
      title: string;
      quantity: number;
    }[];
    trackingNumber?: string;
    trackingUrl?: string;
    shippingAddress?: string;
  };

  // Printify production context
  printifyOrder?: {
    status: string;
    productionStatus: string;
    lineItems: {
      title?: string;
      status: string;
    }[];
    shipments: {
      carrier: string;
      trackingNumber: string;
      trackingUrl?: string;
    }[];
  };

  // Real-time tracking information
  trackingInfo?: {
    status: string; // e.g., "On the Way", "Delivered", "Pending"
    carrier: string;
    trackingNumber: string;
    estimatedDelivery?: string;
    lastUpdate?: string;
    latestEvent?: string;
    productionDays?: number; // Days from production start to carrier pickup
    transitDays?: number; // Days in transit (or days until delivered)
    isDelivered: boolean;
    hasDelay?: boolean; // True if production or pickup is delayed (>4 days)
  };

  // Recent actions taken by the agent
  recentAction?: {
    type: string;
    at: string;
    data?: Record<string, unknown>;
  };

  // Feedback examples for few-shot learning
  feedbackExamples?: {
    original: string;
    edited: string;
  }[];

  // Refinement mode - edit existing draft with instructions
  refinement?: {
    currentDraft: string;
    instructions: string;
  };
}

export interface SuggestionResult {
  draft: string;
  internalNotes?: string[];
  confidence: number;
  warnings?: string[];
}

/**
 * Convert Shopify data to suggestion context
 */
export function buildShopifyContext(
  customer: ShopifyCustomer,
  orders: ShopifyOrder[]
): Partial<SuggestionContext> {
  const context: Partial<SuggestionContext> = {
    customer: {
      name: customer.displayName,
      email: customer.email,
      totalSpent: `${customer.totalSpent} ${customer.totalSpentCurrency}`,
      numberOfOrders: customer.numberOfOrders,
      tags: customer.tags,
    },
  };

  // Add most recent order context
  if (orders.length > 0) {
    const order = orders[0];
    const fulfillment = order.fulfillments[0];

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
      trackingNumber: fulfillment?.trackingNumber,
      trackingUrl: fulfillment?.trackingUrl,
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

  return context;
}

/**
 * Convert Printify data to suggestion context
 */
export function buildPrintifyContext(
  order: PrintifyOrder
): Partial<SuggestionContext> {
  return {
    printifyOrder: {
      status: order.status,
      productionStatus: order.line_items.some((li) => li.status === 'in-production')
        ? 'In Production'
        : order.line_items.every((li) => li.status === 'fulfilled')
        ? 'All Fulfilled'
        : 'Processing',
      lineItems: order.line_items.map((li) => ({
        title: li.metadata?.title,
        status: li.status,
      })),
      shipments: order.shipments.map((s) => ({
        carrier: s.carrier,
        trackingNumber: s.number,
        trackingUrl: s.url,
      })),
    },
  };
}

/**
 * Convert tracking data to suggestion context
 */
export function buildTrackingContext(
  tracking: TrackingResult,
  printifyOrder?: PrintifyOrder
): Partial<SuggestionContext> {
  const now = new Date();
  const DELAY_THRESHOLD = 4;

  // Get production date from Printify if available
  const productionDates = printifyOrder?.line_items
    .map((li) => li.sent_to_production_at)
    .filter((d): d is string => !!d)
    .map((d) => new Date(d));
  const productionAt = productionDates?.length
    ? new Date(Math.min(...productionDates.map((d) => d.getTime())))
    : null;

  // Calculate times
  const shippedAt = tracking.shippedAt ? new Date(tracking.shippedAt) : null;
  const deliveredAt = tracking.deliveredAt ? new Date(tracking.deliveredAt) : null;
  const labelCreatedAt = tracking.labelCreatedAt ? new Date(tracking.labelCreatedAt) : null;

  // Production days (from sent_to_production to carrier pickup)
  const productionDays = productionAt && shippedAt
    ? Math.ceil((shippedAt.getTime() - productionAt.getTime()) / (1000 * 60 * 60 * 24))
    : undefined;

  // Transit days
  const transitDays = shippedAt
    ? deliveredAt
      ? Math.ceil((deliveredAt.getTime() - shippedAt.getTime()) / (1000 * 60 * 60 * 24))
      : Math.ceil((now.getTime() - shippedAt.getTime()) / (1000 * 60 * 60 * 24))
    : undefined;

  // Check for delays
  const productionInProgress = productionAt && !shippedAt;
  const productionWaitDays = productionInProgress
    ? Math.ceil((now.getTime() - productionAt.getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const pickupWaitDays = labelCreatedAt && !shippedAt
    ? Math.ceil((now.getTime() - labelCreatedAt.getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const hasDelay = (productionWaitDays !== null && productionWaitDays > DELAY_THRESHOLD) ||
    (pickupWaitDays !== null && pickupWaitDays > DELAY_THRESHOLD);

  // User-friendly status
  const statusMap: Record<string, string> = {
    pending: 'Pending',
    info_received: 'Label Created',
    in_transit: 'On the Way',
    out_for_delivery: 'Out for Delivery',
    delivered: 'Delivered',
    failed_attempt: 'Delivery Failed',
    exception: 'Issue Detected',
    expired: 'Tracking Expired',
    unknown: 'Unknown',
  };

  return {
    trackingInfo: {
      status: statusMap[tracking.status] || tracking.status,
      carrier: tracking.carrier,
      trackingNumber: tracking.trackingNumber,
      estimatedDelivery: tracking.estimatedDelivery,
      lastUpdate: tracking.lastUpdate,
      latestEvent: tracking.events[0]?.description,
      productionDays,
      transitDays,
      isDelivered: tracking.status === 'delivered',
      hasDelay,
    },
  };
}
