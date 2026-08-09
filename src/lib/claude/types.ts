/**
 * Claude suggestion service types
 */

import { ShopifyAddress, ShopifyCustomer, ShopifyOrder } from '@/lib/shopify/types';
import { PrintifyOrder } from '@/lib/printify/types';
import { PrintifyClient } from '@/lib/printify/client';
import { TrackingResult } from '@/lib/trackingmore';
import { replacementSignal } from '@/lib/ai/replacement-order';

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
  // Attachment filenames on this message (e.g. customer sizing photos). The
  // model can't see the images, but it MUST know they exist - a photo-only
  // reply otherwise reads as an empty message and the draft claims the photo
  // "didn't come through" (Lori, 2026-07-05).
  attachments?: string[];
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
    // Dollar amount already refunded on this order (includes refunds still
    // settling at the gateway - Shopify keeps financialStatus PAID until they
    // settle, so status alone hides a refund the operator just issued).
    refundedAmount?: string;
    // The refund went out as STORE CREDIT, not to the original payment method.
    // Without this the draft promises money back on their card, which is wrong
    // and the customer acts on it.
    refundedToStoreCredit?: boolean;
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
    /**
     * This order is a REPLACEMENT we sent, not a purchase - identified by its
     * tag, its note, or a $0 total. The draft must never offer to refund it or
     * describe it as money the customer spent.
     */
    isReplacement?: string;
  };

  /**
   * The SAME design on our other garments, for every design on the order:
   * Premium, Kids Tee, Toddler, V-Neck, Long Sleeve, Hoodie - each with the
   * sizes it actually offers and its own product link. Without this the draft
   * can only reach for a category COLLECTION, which drops the customer into
   * other people's designs (order #32460: a customer who wanted the 5T of the
   * shirt she bought was sent to the 16-product kids collection).
   */
  designVersions?: {
    design: string;
    versions: {
      title: string;
      url: string;
      productType: string;
      sizes: string[];
      /** Sized for children (toddler/kids/youth), not adults. */
      childSizing: boolean;
      /** This is the exact product on the order. */
      ordered: boolean;
    }[];
  }[];

  // Printify production context
  printifyOrder?: {
    status: string;
    /** Printify's raw status in plain English ("On the Way", "Label Created"). */
    statusLabel: string;
    productionStatus: string;
    /** Printify has created a shipment for this order: it is printed and out of
     *  the print shop, even when the carrier has not scanned it in yet. */
    handedToCarrier: boolean;
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
    /** The carrier's own wording for WHERE a delivered package was left
     *  ("Left at front door", "Handed to resident", plus the location when the
     *  carrier gives one). Kept separate because latestEvent is overwritten
     *  with a plain "Delivered <date>" once delivered - which threw this detail
     *  away, and operators were typing "it was left by your front door" back in
     *  by hand on every lost-package reply (edit digests 2026-07-19/26). */
    deliveryDetail?: string;
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
    /** A replacement WE sent, not something they bought (see replacementSignal). */
    isReplacement?: boolean;
  }[];

  // Result of matching the request to a specific order
  orderMatch?: {
    matchedOrderNumber?: string;
    ambiguous: boolean;
    reason: string;
  };

  // Set when the customer-to-order link is NOT verified (matched by name only,
  // e.g. a contact-form thread where the sender email differs from the order
  // email). The model must not assert order-specific facts as confirmed.
  orderMatchUnverified?: string;

  // Replacement orders that ALREADY exist for this customer - the draft must
  // reference them instead of promising to create a new one
  replacementsAlreadyCreated?: {
    replacementOrder: string;
    forOrder: string;
    createdAt: string;
    fulfillmentStatus: string | null;
    items: string[];
    /** Which signal identified it: the tag, the note, or a $0 total. */
    howWeKnow?: string;
    /** Nothing was charged - never discuss refunding or paying for this one. */
    freeOfCharge?: boolean;
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
      refundedAmount: refundedIfAny(order),
      refundedToStoreCredit: order.refundedToStoreCredit || undefined,
      isReplacement: replacementNote(order),
    };
  }

  return context;
}

/** Human-readable "this is a replacement we sent" note, or undefined. */
function replacementNote(order: ShopifyOrder): string | undefined {
  const signal = replacementSignal(order);
  if (!signal.isReplacement) return undefined;
  return (
    `YES - this is a replacement WE sent${signal.forOrder ? ` for ${signal.forOrder}` : ''}` +
    ` (${signal.why}). The customer paid nothing for it.`
  );
}

/** Refunded dollars on the order as a string, or undefined when nothing was
 *  refunded. Includes refunds still settling (financialStatus still PAID). */
export function refundedIfAny(order: ShopifyOrder): string | undefined {
  const amount = parseFloat(order.totalRefunded || '0');
  return amount > 0 ? amount.toFixed(2) : undefined;
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
  // getProductionStatus reads order.line_items directly, so hand it the guarded
  // copy rather than the raw payload.
  const guarded = { ...order, line_items: lineItems };
  return {
    printifyOrder: {
      status: order.status,
      statusLabel: order.status
        ? PrintifyClient.getStatusDisplay(order.status.toLowerCase())
        : 'Unknown',
      // Order-level status FIRST, then line items. Printify flips the ORDER to
      // shipment_in_transit once the parcel leaves the print shop while the
      // line items can still read "processing" - a line-item-only summary hid
      // that from the draft entirely (Pati, 2026-08-09, order #32796).
      productionStatus: PrintifyClient.getProductionStatus(guarded),
      handedToCarrier: shipments.length > 0,
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
 * Where the carrier says a delivered package was left, in the carrier's own
 * words ("Left at front door", "Handed directly to a resident"), with the
 * location appended when one is given. Prefers the delivery event; falls back
 * to the most recent event so a carrier that only stamps a location still
 * yields something. Returns undefined when there is nothing usable - callers
 * must not present a bare status like "delivered" as a drop location.
 */
function deliveryDetail(tracking: TrackingResult): string | undefined {
  const event =
    tracking.events.find((e) => e.status === 'delivered') || tracking.events[0];
  const description = event?.description?.trim();
  if (!description) return undefined;
  // A description that is just the status word tells the customer nothing.
  if (/^delivered\.?$/i.test(description)) {
    return event?.location ? `Delivered - ${event.location}` : undefined;
  }
  return event?.location ? `${description} (${event.location})` : description;
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
      // The plain "Delivered <date>" above loses WHERE the carrier left it,
      // which is the one detail a "my package never arrived" customer needs.
      // Pull it off the delivery event itself so the draft can say "left at
      // your front door" instead of the operator typing it in every time.
      deliveryDetail: isDelivered ? deliveryDetail(tracking) : undefined,
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
