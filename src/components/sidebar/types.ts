/**
 * Shared types + small data constants for the customer sidebar, extracted from
 * customer-sidebar.tsx so the component file holds UI, not 200 lines of shape
 * declarations. Imported by the component and by sidebar/helpers.ts.
 */

export interface CustomerSidebarProps {
  threadId: string;
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

export interface ShopifyCustomer {
  displayName: string;
  email: string;
  totalSpent: string;
  totalSpentCurrency: string;
  numberOfOrders: number;
  tags: string[];
  note?: string;
  id?: string;
  defaultAddress?: {
    city?: string;
    provinceCode?: string;
    country?: string;
  };
}

export interface ShopifyOrder {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  financialStatus: string;
  fulfillmentStatus: string | null;
  totalPrice: string;
  totalPriceCurrency: string;
  subtotalPrice?: string;
  totalShippingPrice?: string;
  totalTax?: string;
  totalDiscounts?: string;
  discountCodes?: string[];
  totalRefunded?: string;
  /** Shipping dollars already refunded - remaining refundable shipping is
   *  totalShippingPrice minus this (Shopify rejects anything above it). */
  totalRefundedShipping?: string;
  customerEmail?: string;
  lineItems: {
    id: string;
    title: string;
    variantTitle?: string;
    quantity: number;
    productId?: string;
    variantId?: string;
    imageUrl?: string;
    variantImageUrl?: string;
    selectedOptions?: { name: string; value: string }[];
    originalUnitPrice?: string;
    discountedUnitPrice?: string;
    sku?: string;
  }[];
  fulfillments: {
    id: string;
    status: string;
    trackingNumber?: string;
    trackingUrl?: string;
    trackingCompany?: string;
  }[];
  shippingAddress?: ShopifyAddress;
  billingAddress?: ShopifyAddress;
  note?: string;
  tags: string[];
  cancelledAt?: string;
}

export interface PrintifyAddress {
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
}

export interface PrintifyOrderMatch {
  shopifyOrderId: string;
  order: {
    id: string;
    app_order_id?: string;
    status: string;
    created_at?: string;
    address_to: PrintifyAddress;
    line_items: {
      status: string;
      sent_to_production_at?: string;
      metadata?: {
        title?: string;
      };
    }[];
    shipments: {
      carrier: string;
      number: string;
      url?: string;
      shipped_at?: string;
      delivered_at?: string;
    }[];
    printify_connect?: {
      url?: string;
    };
  };
  productionStatus: string;
  matchMethod: string;
  matchConfidence: number;
  /** Carrier tracking status (e.g. in_transit, info_received, delivered) */
  carrierStatus?: string;
}

export interface ProductVariantsResponse {
  productId: string;
  title: string;
  variants: {
    id: string;
    title: string;
    price: string;
    sku?: string;
    availableForSale: boolean;
    imageUrl?: string;
    selectedOptions: { name: string; value: string }[];
  }[];
}

export interface ShippingRateOption {
  id: string;
  title: string;
  price: string;
  currencyCode?: string;
  zoneName?: string;
}

export interface SearchProduct {
  id: string;
  title: string;
  handle: string;
  imageUrl?: string;
  variants: {
    id: string;
    title: string;
    price: string;
    sku?: string;
    availableForSale: boolean;
    imageUrl?: string;
    selectedOptions?: { name: string; value: string }[];
  }[];
}

export interface ReplacementLineItem {
  id: string;
  productId?: string;
  title: string;
  variantId: string;
  variantTitle: string;
  quantity: number;
  imageUrl?: string;
  selectedOptions?: { name: string; value: string }[];
  price?: string;
  sku?: string;
  originalLineItemId?: string;
  originalVariantId?: string; // Track original variant to detect size/variant changes
  originalPrice?: string; // Track original price to calculate difference for discounts
  discount?: string; // Discount amount to apply (fixed amount)
}

export interface ContextData {
  thread?: { customerEmail: string; customerName: string | null };
  customer?: ShopifyCustomer;
  orders?: ShopifyOrder[];
  printifyOrders?: PrintifyOrderMatch[];
  printifySyncNeeded?: boolean;
  storeDomain?: string;
  printifyShopId?: string;
  customerMatchMethod?: 'email' | 'email_typo' | 'name' | 'order_name';
  cached?: boolean;
  // OPEN Printify escalations for this thread/customer, straight from the
  // escalations table - the durable "Escalated to Printify" badge source
  // (thread.lastActionType is a single slot that later actions overwrite).
  openEscalations?: { orderNumber: string; shopifyOrderId: string | null }[];
}

export type VariantWithOptions = {
  selectedOptions?: { name: string; value: string }[];
  title?: string;
};

export const emptyShopifyAddress: ShopifyAddress = {
  name: '',
  firstName: '',
  lastName: '',
  company: '',
  address1: '',
  address2: '',
  city: '',
  province: '',
  provinceCode: '',
  country: '',
  countryCode: '',
  zip: '',
  phone: '',
};

export const defaultReplacementTags = [
  'too small',
  'too big',
  'wrong size ordered',
  'wrong shirt ordered',
  'wrong address',
  'defect',
];
