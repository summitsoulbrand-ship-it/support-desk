/**
 * Printify API types
 */

export interface PrintifyConfig {
  apiToken: string;
  shopId: string;
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

export interface PrintifyLineItem {
  product_id: string;
  quantity: number;
  variant_id: number;
  blueprint_id?: number;
  print_provider_id: number;
  sku?: string;
  cost: number;
  shipping: number;
  status: string;
  metadata?: {
    title?: string;
    variant_label?: string;
    sku?: string;
    print_provider?: string;
  };
  sent_to_production_at?: string;
  fulfilled_at?: string;
}

export interface PrintifyShipment {
  carrier: string;
  number: string;
  url?: string;
  shipped_at?: string;
  delivered_at?: string;
}

export interface PrintifyOrder {
  id: string;
  app_order_id?: string; // Printify's display order number (e.g., "19269685.5884")
  external_id?: string; // Usually Shopify order ID/number
  label?: string;
  status: string;
  created_at: string;
  updated_at?: string;
  sent_to_production_at?: string; // When production started
  fulfilled_at?: string; // When production completed and shipped to carrier
  address_to: PrintifyAddress;
  line_items: PrintifyLineItem[];
  shipments: PrintifyShipment[];
  total_price: number;
  total_shipping: number;
  total_tax: number;
  printify_connect?: {
    url?: string;
  };

  // Metadata from external system
  metadata?: {
    order_type?: string;
    shop_order_id?: string;
    shop_order_label?: string;
    shop_fulfilled_at?: string;
  };
}

export interface PrintifyOrderMatch {
  order: PrintifyOrder;
  matchMethod: 'metafield' | 'external_id' | 'order_number' | 'email_time_items';
  matchConfidence: number; // 0-1
}

export interface PrintifyVariant {
  id: number;
  sku: string;
  cost: number;
  price: number;
  title: string;
  grams: number;
  is_enabled: boolean;
  is_default: boolean;
  is_available: boolean;
  is_printify_express_eligible?: boolean;
  options?: number[]; // Option value IDs (e.g., size ID, color ID)
}

export interface PrintifyProduct {
  id: string;
  title: string;
  description?: string;
  blueprint_id: number;
  print_provider_id: number;
  print_provider_title?: string;
  variants: PrintifyVariant[];
  print_areas?: unknown[];
  images?: { src: string; variant_ids: number[]; position: string }[];
  created_at?: string;
  updated_at?: string;
  visible?: boolean;
  is_locked?: boolean;
  external?: {
    id?: string;
    handle?: string;
  };
}
