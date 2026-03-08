/**
 * Printify API Client
 * Fetches order data and matches with Shopify orders
 */

import {
  PrintifyConfig,
  PrintifyOrder,
  PrintifyOrderMatch,
} from './types';
import { ShopifyOrder } from '@/lib/shopify/types';

const API_BASE = 'https://api.printify.com/v1';

interface PrintifyShop {
  id: string;
  title?: string;
}

export class PrintifyClient {
  private config: PrintifyConfig;

  constructor(config: PrintifyConfig) {
    this.config = config;
  }

  getShopId(): string {
    return this.config.shopId;
  }

  /**
   * Make an API request
   */
  private async request<T>(
    endpoint: string,
    method: string = 'GET',
    body?: unknown
  ): Promise<T> {
    const url = `${API_BASE}${endpoint}`;

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Printify API error: ${response.status} - ${text}`);
    }

    return response.json();
  }

  /**
   * List shops accessible by the token
   */
  private async listShops(): Promise<PrintifyShop[]> {
    const data = await this.request<unknown>('/shops.json');
    if (Array.isArray(data)) {
      return data as PrintifyShop[];
    }
    if (data && typeof data === 'object') {
      const maybe = data as { data?: unknown };
      if (Array.isArray(maybe.data)) {
        return maybe.data as PrintifyShop[];
      }
    }
    return [];
  }

  private static normalizeShopId(id: unknown): string {
    if (id === null || id === undefined) {
      return '';
    }
    return String(id).trim();
  }

  /**
   * Test API connection
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const shops = await this.listShops();
      if (shops.length === 0) {
        return { success: false, error: 'No shops returned for this token' };
      }

      const configuredId = PrintifyClient.normalizeShopId(this.config.shopId);
      const hasShop = shops.some(
        (s) => PrintifyClient.normalizeShopId(s.id) === configuredId
      );
      if (!hasShop) {
        const available = shops
          .map((s) => PrintifyClient.normalizeShopId(s.id))
          .filter((id) => id.length > 0)
          .join(', ');
        return {
          success: false,
          error:
            `Shop ID not found for this token.` +
            (available ? ` Available shop IDs: ${available}` : ''),
        };
      }

      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error };
    }
  }

  /**
   * Get a specific order by ID
   */
  async getOrder(orderId: string): Promise<PrintifyOrder | null> {
    try {
      const order = await this.request<PrintifyOrder>(
        `/shops/${this.config.shopId}/orders/${orderId}.json`
      );
      return order;
    } catch {
      return null;
    }
  }

  /**
   * List orders with pagination
   */
  async listOrdersPage(
    page: number = 1,
    limit: number = 10
  ): Promise<{ current_page: number; last_page: number; data: PrintifyOrder[] }> {
    try {
      interface OrdersResponse {
        current_page: number;
        data: PrintifyOrder[];
        last_page: number;
      }

      const safeLimit = Math.min(Math.max(limit, 1), 50);

      const response = await this.request<OrdersResponse>(
        `/shops/${this.config.shopId}/orders.json?page=${page}&limit=${safeLimit}`
      );
      return response;
    } catch (err) {
      console.error('Error listing Printify orders:', err);
      return { current_page: page, last_page: page, data: [] };
    }
  }

  async listOrders(page: number = 1, limit: number = 10): Promise<PrintifyOrder[]> {
    const response = await this.listOrdersPage(page, limit);
    return response.data;
  }

  /**
   * Create a Printify order using SKUs
   */
  async createOrderWithSkus(input: {
    externalId: string;
    label?: string;
    addressTo: {
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
    lineItems: { sku: string; quantity: number }[];
  }): Promise<{ success: boolean; error?: string }> {
    try {
      await this.request(
        `/shops/${this.config.shopId}/orders.json`,
        'POST',
        {
          external_id: input.externalId,
          label: input.label,
          address_to: input.addressTo,
          line_items: input.lineItems.map((item) => ({
            sku: item.sku,
            quantity: item.quantity,
          })),
        }
      );
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error };
    }
  }

  /**
   * Cancel a Printify order
   */
  async cancelOrder(orderId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.request(
        `/shops/${this.config.shopId}/orders/${orderId}/cancel.json`,
        'POST'
      );
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error };
    }
  }

  /**
   * Send order to production (release hold)
   */
  async sendToProduction(orderId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.request(
        `/shops/${this.config.shopId}/orders/${orderId}/send_to_production.json`,
        'POST'
      );
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error };
    }
  }

  /**
   * Create a Printify order with full line item details (for combining orders)
   * Uses print_details format for line items
   */
  async createOrderWithPrintDetails(input: {
    externalId: string;
    label?: string;
    addressTo: {
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
    lineItems: {
      print_provider_id: number;
      blueprint_id: number;
      variant_id: number;
      print_areas: Record<string, unknown>;
      quantity: number;
    }[];
    sendShippingNotification?: boolean;
  }): Promise<{ success: boolean; orderId?: string; error?: string }> {
    try {
      const response = await this.request<{ id: string }>(
        `/shops/${this.config.shopId}/orders.json`,
        'POST',
        {
          external_id: input.externalId,
          label: input.label,
          address_to: input.addressTo,
          line_items: input.lineItems.map((item) => ({
            print_provider_id: item.print_provider_id,
            blueprint_id: item.blueprint_id,
            variant_id: item.variant_id,
            print_areas: item.print_areas,
            quantity: item.quantity,
          })),
          send_shipping_notification: input.sendShippingNotification ?? true,
        }
      );
      return { success: true, orderId: response.id };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error };
    }
  }

  /**
   * Check if an order can be cancelled (not yet in production)
   */
  static canCancelOrder(order: PrintifyOrder): boolean {
    const inProductionStatuses = new Set([
      'in-production',
      'shipping',
      'fulfilled',
      'partially-fulfilled',
      'delivered',
      'shipment_in_transit',
      'shipment_out_for_delivery',
      'shipment_delivered',
    ]);

    // Check order-level status
    if (order.sent_to_production_at) {
      return false;
    }

    // Check line item statuses
    return !order.line_items.some(
      (li) => inProductionStatuses.has(li.status) || li.sent_to_production_at
    );
  }

  /**
   * Find orders by external ID (usually Shopify order number)
   */
  async findByExternalId(externalId: string): Promise<PrintifyOrder | null> {
    try {
      const normalize = (value: string) => value.replace(/^#/, '').trim();
      const normalized = normalize(externalId);
      const candidates = new Set(
        [externalId, normalized, `#${normalized}`].filter(
          (value): value is string => value.length > 0
        )
      );

      const matches = (value?: string) => {
        if (!value) return false;
        const cleaned = normalize(value);
        return (
          candidates.has(value) ||
          candidates.has(cleaned) ||
          candidates.has(`#${cleaned}`)
        );
      };

      // Printify doesn't have direct lookup by external_id
      // We need to search through recent orders
      for (const page of [1, 2, 3, 4, 5]) {
        const orders = await this.listOrders(page, 50);

        const match =
          orders.find(
            (o) =>
              matches(o.external_id) ||
              matches(o.metadata?.shop_order_id) ||
              matches(o.metadata?.shop_order_label) ||
              matches(o.label)
          ) || null;

        if (match) {
          return match;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Match a Shopify order to a Printify order
   * Uses multiple strategies with confidence scoring
   */
  async matchShopifyOrder(
    shopifyOrder: ShopifyOrder
  ): Promise<PrintifyOrderMatch | null> {
    // Strategy 1: Check metafield for explicit Printify order ID
    const printifyMeta = shopifyOrder.metafields?.find(
      (m) =>
        m.key === 'order_id' ||
        m.key === 'printify_order' ||
        m.key.includes('printify')
    );

    if (printifyMeta?.value) {
      const order = await this.getOrder(printifyMeta.value);
      if (order) {
        return {
          order,
          matchMethod: 'metafield',
          matchConfidence: 1.0,
        };
      }
    }

    // Strategy 2: Match by external_id (Shopify order number)
    const orderNumber = shopifyOrder.name.replace('#', '');
    const byExternalId = await this.findByExternalId(orderNumber);

    if (byExternalId) {
      return {
        order: byExternalId,
        matchMethod: 'external_id',
        matchConfidence: 0.95,
      };
    }

    // Strategy 3: Match by Shopify order ID
    const shopifyId = shopifyOrder.id.replace('gid://shopify/Order/', '');
    const byShopifyId = await this.findByExternalId(shopifyId);

    if (byShopifyId) {
      return {
        order: byShopifyId,
        matchMethod: 'order_number',
        matchConfidence: 0.9,
      };
    }

    // Strategy 3b: Match by full Shopify order name (e.g. "#11079")
    const byOrderName = await this.findByExternalId(shopifyOrder.name);
    if (byOrderName) {
      return {
        order: byOrderName,
        matchMethod: 'order_number',
        matchConfidence: 0.9,
      };
    }

    // Strategy 4: Fuzzy match by email + date + items
    const fuzzyMatch = await this.fuzzyMatchOrder(shopifyOrder);
    if (fuzzyMatch) {
      return fuzzyMatch;
    }

    return null;
  }

  /**
   * Fuzzy match order by email, date window, and line items
   */
  private async fuzzyMatchOrder(
    shopifyOrder: ShopifyOrder
  ): Promise<PrintifyOrderMatch | null> {
    try {
      const orders = await this.listOrders(1, 50);

      const shopifyDate = new Date(shopifyOrder.createdAt);
      const shopifyEmail = shopifyOrder.customerEmail?.toLowerCase();

      for (const order of orders) {
        // Check email match
        const printifyEmail = order.address_to.email?.toLowerCase();
        if (!printifyEmail || printifyEmail !== shopifyEmail) {
          continue;
        }

        // Check date within 1 hour window
        const printifyDate = new Date(order.created_at);
        const timeDiff = Math.abs(
          shopifyDate.getTime() - printifyDate.getTime()
        );
        const hourInMs = 60 * 60 * 1000;

        if (timeDiff > hourInMs) {
          continue;
        }

        // Check item count similarity
        const shopifyItemCount = shopifyOrder.lineItems.reduce(
          (sum, li) => sum + li.quantity,
          0
        );
        const printifyItemCount = order.line_items.reduce(
          (sum, li) => sum + li.quantity,
          0
        );

        if (shopifyItemCount !== printifyItemCount) {
          continue;
        }

        // Calculate confidence based on time proximity
        const confidence = 1 - timeDiff / hourInMs;

        return {
          order,
          matchMethod: 'email_time_items',
          matchConfidence: Math.max(0.5, confidence * 0.8),
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get order status display text (user-friendly)
   */
  static getStatusDisplay(status: string): string {
    const statusMap: Record<string, string> = {
      // Line item statuses
      pending: 'Order Received',
      'on-hold': 'On Hold',
      'checking-quality': 'Quality Check',
      'sending-to-production': 'Preparing for Production',
      'in-production': 'Being Printed',
      shipping: 'Preparing to Ship',
      fulfilled: 'Shipped',
      'partially-fulfilled': 'Partially Shipped',
      cancelled: 'Cancelled',
      archived: 'Archived',
      // Order-level statuses
      'shipment_pre_transit': 'Label Created',
      'shipment_in_transit': 'On the Way',
      'shipment_out_for_delivery': 'Out for Delivery',
      'shipment_delivered': 'Delivered',
      'shipment_failure': 'Delivery Failed',
      'shipment_returned': 'Returned to Sender',
      'shipment_available_for_pickup': 'Ready for Pickup',
      'action-required': 'Action Required',
      'has-issues': 'Issue Detected',
      'payment-not-received': 'Awaiting Payment',
      'awaiting-payment': 'Awaiting Payment',
      'ready-for-shipping': 'Ready to Ship',
    };

    return statusMap[status] || status;
  }

  /**
   * Get production status for an order (user-friendly)
   * Checks order-level status first, then falls back to line item statuses
   */
  static getProductionStatus(order: PrintifyOrder): string {
    // Check order-level status first for shipment statuses
    const orderStatus = order.status?.toLowerCase();
    if (orderStatus) {
      // Handle shipment statuses at order level
      if (orderStatus === 'shipment_delivered' || orderStatus === 'delivered') {
        return 'Delivered';
      }
      if (orderStatus === 'shipment_out_for_delivery') {
        return 'Out for Delivery';
      }
      if (orderStatus === 'shipment_in_transit' || orderStatus === 'in_transit') {
        return 'On the Way';
      }
      if (orderStatus === 'shipment_pre_transit') {
        return 'Label Created';
      }
      if (orderStatus === 'shipment_failure') {
        return 'Delivery Failed';
      }
      if (orderStatus === 'shipment_returned') {
        return 'Returned to Sender';
      }
      if (orderStatus === 'shipment_available_for_pickup') {
        return 'Ready for Pickup';
      }
      if (orderStatus === 'cancelled' || orderStatus === 'canceled') {
        return 'Cancelled';
      }
    }

    // Fall back to line item statuses
    const statuses = order.line_items.map((li) => li.status);
    const uniqueStatuses = [...new Set(statuses)];

    if (uniqueStatuses.length === 1) {
      return this.getStatusDisplay(uniqueStatuses[0]);
    }

    const inProduction = statuses.filter((s) => s === 'in-production').length;
    const fulfilled = statuses.filter((s) => s === 'fulfilled').length;

    if (fulfilled === statuses.length) {
      return 'Shipped';
    }

    if (inProduction > 0) {
      return `${inProduction}/${statuses.length} Being Printed`;
    }

    return 'Processing';
  }
}
