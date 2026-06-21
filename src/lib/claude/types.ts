/**
 * Claude suggestion service types
 */

import { ShopifyAddress, ShopifyCustomer, ShopifyOrder } from '@/lib/shopify/types';
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
    // For an order that has NOT shipped yet (no carrier ETA), a computed
    // "estimated to arrive between X and Y" window from the order date + the
    // made-to-order timeline. The carrier ETA (trackingInfo.estimatedDelivery)
    // always takes precedence once it exists.
    estimatedDeliveryWindow?: string;
    // Billing address on file, included ONLY when it differs from the shipping
    // address. Used as a candidate when a customer asks to redirect an order to
    // a place but does not give the full new address - the draft offers this for
    // the customer to confirm. Never used to silently re-route.
    billingAddressOnFile?: string;
    // Set on an ADDRESS_UPDATE thread when the address the customer asked for
    // already matches the order's current shipping address - i.e. nothing needs
    // changing (e.g. they re-ordered with the corrected address themselves).
    addressChangeNote?: string;
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
    deliveredAt?: string; // Human-readable delivery date/time, when delivered
    // True only once the carrier actually has the package (in transit or
    // later). A created label / "info received" is NOT shipped.
    hasShipped: boolean;
    hasDelay?: boolean; // True if production or pickup is delayed (>4 days)
    /** Whole days since the carrier's last scan/event, when known. */
    daysSinceLastUpdate?: number;
    /** Shipped, not delivered, and no new carrier scan in several days - the
     *  package can look stuck even though the last scan is old, not current. */
    stalled?: boolean;
    /** Carrier's proof-of-delivery document/photo, when available */
    proofOfDeliveryUrl?: string;
  };

  // Recent actions taken by the agent
  recentAction?: {
    type: string;
    at: string;
    data?: Record<string, unknown>;
  };

  // AI triage classification of the customer's latest message
  triage?: {
    intent: string;
    confidence: number;
    entities?: Record<string, unknown>;
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

  // Store knowledge (brand voice, avatar, Shopify pages + policies)
  knowledge?: {
    title: string;
    content: string;
  }[];

  // When the customer has more than one order, the full list so the model can
  // identify the right one or ask which order the request is about.
  orderCandidates?: {
    orderNumber: string;
    createdAt: string;
    fulfillmentStatus: string | null;
    items: string[]; // "Black Tee - M (x1)"
  }[];

  // Result of matching the request to a specific order
  orderMatch?: {
    matchedOrderNumber?: string;
    ambiguous: boolean;
    reason: string;
  };

  // Replacement orders that ALREADY exist for this customer - the draft must
  // reference them instead of promising to create a new one
  replacementsAlreadyCreated?: {
    replacementOrder: string;
    forOrder: string;
    createdAt: string;
    fulfillmentStatus: string | null;
    items: string[];
  }[];

  // A size exchange was requested, but the size the customer says they have
  // does NOT appear on any of their orders. The premise is wrong (they may
  // have misremembered, or mean a different order), so the draft must ask to
  // clarify instead of confirming a replacement.
  exchangeSizeIssue?: {
    claimedSize: string; // what the customer said they have, e.g. "L"
    orderNumber: string; // the order we're looking at
    orderedSizes: string[]; // sizes actually on that order, e.g. ["S", "M"]
  };

  // A change/exchange was requested AND the order has not yet been sent to
  // production, so we can change the order itself before it prints - no free
  // replacement, no duplicate for the customer to keep. The draft should
  // confirm we caught it in time and updated the order.
  changeBeforeProduction?: {
    orderNumber: string;
  };

  // Situational guidance for this specific draft (e.g. exchange pending approval)
  extraInstructions?: string;

  // Real recent replies the team sent to SIMILAR messages (same intent), used
  // as few-shot examples so the draft mirrors how Pati actually answers - the
  // style/completeness lever that adding more rules can't buy.
  fewShotExamples?: { customer: string; reply: string }[];
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
      shippingAddress: formatAddressLine(order.shippingAddress),
      billingAddressOnFile: billingIfDiffers(order),
    };
  }

  return context;
}

/** One-line "address1, city, ST, zip, CC" from a Shopify address, or undefined. */
export function formatAddressLine(addr?: ShopifyAddress): string | undefined {
  if (!addr) return undefined;
  const line = [addr.address1, addr.city, addr.provinceCode, addr.zip, addr.countryCode]
    .filter(Boolean)
    .join(', ');
  return line || undefined;
}

/**
 * The billing address on file, but ONLY when it is a meaningfully different
 * destination than the shipping address (different street or city/state). When
 * billing and shipping match we return undefined so the model is not handed a
 * redundant line. This is the candidate the draft offers a customer to confirm
 * when they ask to redirect an order without giving the full new address.
 */
export function billingIfDiffers(order: ShopifyOrder): string | undefined {
  const billing = formatAddressLine(order.billingAddress);
  if (!billing) return undefined;
  const shipping = formatAddressLine(order.shippingAddress);
  if (shipping && billing.toLowerCase() === shipping.toLowerCase()) return undefined;
  return billing;
}

/**
 * Convert Printify data to suggestion context
 */
export function buildPrintifyContext(
  order: PrintifyOrder
): Partial<SuggestionContext> {
  // Not-yet-shipped orders have no `shipments` array, and some payloads omit
  // `line_items` - guard both, or this throws and the caller's catch silently
  // drops ALL Printify production/tracking context from the AI's prompt.
  const lineItems = order.line_items ?? [];
  const shipments = order.shipments ?? [];
  return {
    printifyOrder: {
      status: order.status,
      productionStatus: lineItems.some((li) => li.status === 'in-production')
        ? 'In Production'
        : lineItems.length > 0 && lineItems.every((li) => li.status === 'fulfilled')
        ? 'All Fulfilled'
        : 'Processing',
      lineItems: lineItems.map((li) => ({
        title: li.metadata?.title,
        status: li.status,
      })),
      shipments: shipments.map((s) => ({
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

  // Get production date from Printify if available (guard missing line_items)
  const productionDates = printifyOrder?.line_items
    ?.map((li) => li.sent_to_production_at)
    .filter((d): d is string => !!d)
    .map((d) => new Date(d));
  const productionAt = productionDates?.length
    ? new Date(Math.min(...productionDates.map((d) => d.getTime())))
    : null;

  // Calculate times. Printify gets delivery confirmation from the carrier and
  // is often AHEAD of the cached TrackingMore snapshot - so a Printify
  // delivered_at means delivered even if the tracking cache still says transit.
  const shippedAt = tracking.shippedAt ? new Date(tracking.shippedAt) : null;
  const printifyDeliveredAt = printifyOrder?.shipments?.[0]?.delivered_at
    ? new Date(printifyOrder.shipments[0].delivered_at)
    : null;
  const deliveredAt =
    (tracking.deliveredAt ? new Date(tracking.deliveredAt) : null) ||
    printifyDeliveredAt;
  const isDelivered = tracking.status === 'delivered' || !!printifyDeliveredAt;
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
    pending: 'Not shipped yet (processing)',
    info_received: 'Label created - NOT shipped yet (carrier has not picked it up)',
    in_transit: 'Shipped, on the way',
    out_for_delivery: 'Out for Delivery',
    delivered: 'Delivered',
    failed_attempt: 'Delivery Failed',
    exception: 'Issue Detected',
    expired: 'Tracking Expired',
    unknown: 'Not shipped yet (no carrier movement)',
  };

  const hasShipped =
    isDelivered ||
    tracking.status === 'in_transit' ||
    tracking.status === 'out_for_delivery' ||
    tracking.status === 'delivered';

  // No carrier ETA published? Derive one from pickup date + the carrier's
  // typical transit time for the route, clearly labeled as an estimate.
  let estimatedDelivery = tracking.estimatedDelivery;
  if (
    !estimatedDelivery &&
    !deliveredAt &&
    shippedAt &&
    tracking.transitTimeDays
  ) {
    const eta = new Date(shippedAt);
    eta.setDate(eta.getDate() + tracking.transitTimeDays);
    estimatedDelivery = `around ${eta.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    })} (estimated from the carrier's typical transit time, not a guaranteed date)`;
  }

  // How long since the carrier last scanned the package - a shipped-but-not-
  // delivered package with no recent scan is "stalled" and looks stuck even
  // though the last event is old, not current movement.
  let daysSinceLastUpdate: number | undefined;
  if (tracking.lastUpdate) {
    const last = new Date(tracking.lastUpdate).getTime();
    if (!Number.isNaN(last)) {
      daysSinceLastUpdate = Math.floor((Date.now() - last) / (24 * 60 * 60 * 1000));
    }
  }
  const stalled =
    hasShipped && !isDelivered && (daysSinceLastUpdate ?? 0) >= 4;

  return {
    trackingInfo: {
      status: isDelivered ? 'Delivered' : statusMap[tracking.status] || tracking.status,
      carrier: tracking.carrier,
      trackingNumber: tracking.trackingNumber,
      daysSinceLastUpdate,
      stalled,
      // A delivered package has no future ETA to promise.
      estimatedDelivery: isDelivered ? undefined : estimatedDelivery,
      lastUpdate: tracking.lastUpdate,
      latestEvent: isDelivered
        ? deliveredAt
          ? `Delivered ${deliveredAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`
          : 'Delivered'
        : tracking.events[0]?.description,
      productionDays,
      transitDays,
      isDelivered,
      deliveredAt:
        isDelivered && deliveredAt
          ? deliveredAt.toLocaleString('en-US', {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })
          : undefined,
      hasShipped,
      hasDelay,
    },
  };
}
