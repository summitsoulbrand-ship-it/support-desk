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
