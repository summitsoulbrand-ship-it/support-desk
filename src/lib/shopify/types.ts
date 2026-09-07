/**
 * Shopify API types
 */

export interface ShopifyConfig {
  storeDomain: string; // e.g., "your-store.myshopify.com"
  accessToken: string;
}

export interface ShopifyCustomer {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  displayName: string;
  phone?: string;
  tags: string[];
  totalSpent: string;
  totalSpentCurrency: string;
  numberOfOrders: number;
  createdAt: string;
  note?: string;
  defaultAddress?: ShopifyAddress;
}

export interface ShopifyAddress {
  name?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  provinceCode?: string;
  country?: string;
  countryCode?: string;
  zip?: string;
  phone?: string;
}

export interface ShopifyLineItem {
  id: string;
  title: string;
  variantTitle?: string;
  quantity: number;
  originalUnitPrice: string;
  originalUnitPriceCurrency: string;
  discountedUnitPrice?: string; // Price after discounts (what customer actually paid per unit)
  sku?: string;
  productId?: string;
  variantId?: string;
  imageUrl?: string;
  variantImageUrl?: string;
  selectedOptions?: { name: string; value: string }[];
}

export interface ShopifyFulfillment {
  id: string;
  status: string;
  trackingNumber?: string;
  trackingUrl?: string;
  trackingCompany?: string;
  createdAt: string;
  updatedAt: string;
  lineItems: {
    id: string;
    quantity: number;
  }[];
}

export interface ShopifyOrder {
  id: string;
  legacyResourceId: string;
  name: string; // Order number like "#1001"
  orderNumber: number;
  createdAt: string;
  updatedAt: string;
  financialStatus: string;
  fulfillmentStatus: string | null;
  totalPrice: string;
  totalPriceCurrency: string;
  subtotalPrice: string;
  totalShippingPrice: string;
  totalTax: string;
  totalDiscounts?: string;
  discountCodes?: string[];
  /** Balance the customer still owes (e.g. after an order edit added a pricier item) */
  totalOutstanding?: string;
  totalRefunded?: string;
  /** Money actually captured on the order (what a cancel can refund back). */
  totalReceived?: string;
  /** Shipping dollars already refunded - remaining refundable shipping is
   *  totalShippingPrice minus this (Shopify rejects a shipping refund above it). */
  totalRefundedShipping?: string;
  /** A refund on this order went out as STORE CREDIT, not back to the card. */
  refundedToStoreCredit?: boolean;
  lineItems: ShopifyLineItem[];
  fulfillments: ShopifyFulfillment[];
  shippingAddress?: ShopifyAddress;
  billingAddress?: ShopifyAddress;
  note?: string;
  tags: string[];
  customerId: string;
  customerEmail?: string;
  cancelledAt?: string;
  cancelReason?: string;

  // Metafields for Printify linking
  metafields?: {
    key: string;
    namespace: string;
    value: string;
  }[];
}

export interface CustomerWithOrders {
  customer: ShopifyCustomer;
  orders: ShopifyOrder[];
}

/**
 * A discount code exactly as the Admin API returns it. Deliberately loose:
 * Shopify's discount union has many shapes and the reply only needs the few
 * fields that decide whether a code applies. Interpreted by
 * `src/lib/ai/discount-terms.ts`.
 */
export interface RawDiscountNode {
  codeDiscount?: {
    __typename?: string;
    title?: string;
    status?: string;
    startsAt?: string | null;
    endsAt?: string | null;
    appliesOncePerCustomer?: boolean;
    combinesWith?: {
      orderDiscounts?: boolean;
      productDiscounts?: boolean;
      shippingDiscounts?: boolean;
    };
    customerGets?: {
      value?: {
        __typename?: string;
        amount?: { amount?: string; currencyCode?: string };
        appliesOnEachItem?: boolean;
        percentage?: number;
      };
      items?: {
        __typename?: string;
        allItems?: boolean;
        collections?: {
          nodes?: {
            title?: string;
            ruleSet?: {
              appliedDisjunctively?: boolean;
              rules?: { column?: string; relation?: string; condition?: string }[];
            } | null;
          }[];
        };
        products?: { nodes?: { title?: string }[] };
      };
    };
    minimumRequirement?: {
      __typename?: string;
      greaterThanOrEqualToQuantity?: string;
      greaterThanOrEqualToSubtotal?: { amount?: string; currencyCode?: string };
    };
  } | null;
}
