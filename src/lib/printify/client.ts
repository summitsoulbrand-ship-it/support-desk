/**
 * Printify API Client
 * Fetches order data and matches with Shopify orders
 */

import {
  PrintifyConfig,
  PrintifyOrder,
  PrintifyOrderMatch,
  PrintifyProduct,
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
   * Create a Printify order and return the created order
   * Used for rerouting international orders
   */
  async createOrder(input: {
    external_id?: string;
    label?: string;
    shipping_method?: number;
    address_to: {
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
    line_items: {
      sku?: string;
      quantity: number;
      blueprint_id?: number;
      variant_id?: number;
    }[];
    send_shipping_notification?: boolean;
  }): Promise<PrintifyOrder> {
    return this.request<PrintifyOrder>(
      `/shops/${this.config.shopId}/orders.json`,
      'POST',
      input
    );
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
   * List all products in the shop
   */
  async listProducts(page: number = 1, limit: number = 100): Promise<{
    current_page: number;
    last_page: number;
    data: PrintifyProduct[];
  }> {
    return this.request(
      `/shops/${this.config.shopId}/products.json?page=${page}&limit=${limit}`
    );
  }

  /**
   * Get a specific product by ID
   */
  async getProduct(productId: string): Promise<PrintifyProduct> {
    return this.request(`/shops/${this.config.shopId}/products/${productId}.json`);
  }

  /**
   * Regional print providers by country code
   * Used as fallback when Printify Choice doesn't have the variant
   */
  private static REGIONAL_PROVIDERS: Record<string, string[]> = {
    // UK
    'GB': ['Shirt Monkey', 'Print Geek'],
    'UK': ['Shirt Monkey', 'Print Geek'],
    // Europe
    'DE': ['Print Geek', 'Duplium'],
    'FR': ['Print Geek', 'Duplium'],
    'ES': ['Print Geek', 'Duplium'],
    'IT': ['Print Geek', 'Duplium'],
    'NL': ['Print Geek', 'Duplium'],
    // Australia
    'AU': ['Print Bar', 'Print Geek'],
    // Canada
    'CA': ['Print Geek', 'OPT OnDemand'],
    // Default fallback for other countries
    'DEFAULT': ['Print Geek', 'Duplium', 'Print Clever'],
  };

  /**
   * Normalize a variant title for comparison
   * Handles different formats like "Black / M", "M / Black", "Black, M", etc.
   */
  private normalizeVariantTitle(title: string): string {
    // Convert to lowercase and split by common separators
    const parts = title
      .toLowerCase()
      .split(/\s*[\/,\-]\s*/)
      .map((p) => p.trim())
      .filter(Boolean)
      .sort(); // Sort to handle different orderings

    return parts.join('|');
  }

  /**
   * Get regional providers for a country
   */
  private getRegionalProviders(countryCode: string): string[] {
    const code = countryCode.toUpperCase();
    return PrintifyClient.REGIONAL_PROVIDERS[code] || PrintifyClient.REGIONAL_PROVIDERS['DEFAULT'];
  }

  /**
   * Find a variant for international routing with fallbacks:
   * 1. Printify Choice (auto-routes globally)
   * 2. Regional provider based on destination country
   * 3. Returns null if no match (caller should create new product)
   */
  async findInternationalVariant(
    originalProduct: PrintifyProduct,
    originalVariantId: number,
    destinationCountry: string
  ): Promise<{
    productId: string;
    variantId: number;
    sku: string;
    provider: string;
    method: 'printify_choice' | 'regional';
  } | null> {
    // Find the original variant to get its title
    const originalVariant = originalProduct.variants.find(
      (v) => v.id === originalVariantId
    );
    if (!originalVariant) return null;

    const originalTitleNormalized = this.normalizeVariantTitle(originalVariant.title);

    // Build priority list: Printify Choice first, then regional providers
    const providerPriority = [
      { name: 'printify choice', method: 'printify_choice' as const },
      ...this.getRegionalProviders(destinationCountry).map((p) => ({
        name: p.toLowerCase(),
        method: 'regional' as const,
      })),
    ];

    // Cache products to avoid fetching multiple times
    let allProducts: PrintifyProduct[] | null = null;

    const fetchAllProducts = async () => {
      if (allProducts !== null) return allProducts;

      allProducts = [];
      let page = 1;
      let lastPage = 1;

      do {
        const response = await this.listProducts(page, 100);
        lastPage = response.last_page;
        allProducts.push(...response.data);
        page++;
      } while (page <= lastPage);

      return allProducts;
    };

    // Search for each provider in priority order
    for (const { name, method } of providerPriority) {
      const products = await fetchAllProducts();

      for (const product of products) {
        // Check if this product uses the target provider
        if (!product.print_provider_title?.toLowerCase().includes(name)) {
          continue;
        }

        // Check if it's the same blueprint
        if (product.blueprint_id !== originalProduct.blueprint_id) {
          continue;
        }

        // Find a variant with matching title
        for (const variant of product.variants) {
          if (!variant.is_enabled) continue;

          const variantTitleNormalized = this.normalizeVariantTitle(variant.title);

          if (variantTitleNormalized === originalTitleNormalized) {
            return {
              productId: product.id,
              variantId: variant.id,
              sku: variant.sku,
              provider: product.print_provider_title || name,
              method,
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Find a Printify Choice variant that matches the given variant properties
   * Matches by variant title (e.g., "Black / M") since option IDs differ between providers
   * Returns the product_id and variant_id for the Printify Choice version
   * @deprecated Use findInternationalVariant instead for full fallback support
   */
  async findPrintifyChoiceVariant(
    originalProduct: PrintifyProduct,
    originalVariantId: number
  ): Promise<{ productId: string; variantId: number; sku: string } | null> {
    const result = await this.findInternationalVariant(
      originalProduct,
      originalVariantId,
      'DEFAULT'
    );
    if (result && result.method === 'printify_choice') {
      return {
        productId: result.productId,
        variantId: result.variantId,
        sku: result.sku,
      };
    }
    return null;
  }

  /**
   * Duplicate a product with a different print provider (Printify Choice)
   * Creates product in draft status
   */
  async duplicateProductAsPrintifyChoice(
    originalProduct: PrintifyProduct,
    blueprintPrintProviders: { id: number; title: string }[]
  ): Promise<{
    success: boolean;
    productId?: string;
    error?: string;
  }> {
    try {
      // Find Printify Choice provider for this blueprint
      const printifyChoiceProvider = blueprintPrintProviders.find(
        (p) => p.title.toLowerCase().includes('printify choice')
      );

      if (!printifyChoiceProvider) {
        return {
          success: false,
          error: 'Printify Choice not available for this product type',
        };
      }

      // Create new product title
      const newTitle = `${originalProduct.title} (Printify Choice) Global`;

      // Get the print areas from original product
      const printAreas = originalProduct.print_areas || [];

      // Build variants - enable all that are available
      const variants = originalProduct.variants.map((v) => ({
        id: v.id,
        price: v.price,
        is_enabled: v.is_enabled,
      }));

      // Create the new product
      const newProduct = await this.request<PrintifyProduct>(
        `/shops/${this.config.shopId}/products.json`,
        'POST',
        {
          title: newTitle,
          description: originalProduct.description || '',
          blueprint_id: originalProduct.blueprint_id,
          print_provider_id: printifyChoiceProvider.id,
          variants,
          print_areas: printAreas,
        }
      );

      // Set to draft/unpublished status
      await this.request(
        `/shops/${this.config.shopId}/products/${newProduct.id}/unpublish.json`,
        'POST'
      );

      return {
        success: true,
        productId: newProduct.id,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to create product',
      };
    }
  }

  /**
   * Get print providers available for a blueprint
   */
  async getBlueprintPrintProviders(
    blueprintId: number
  ): Promise<{ id: number; title: string }[]> {
    try {
      const response = await this.request<{
        id: number;
        title: string;
        location: { country: string };
      }[]>(`/catalog/blueprints/${blueprintId}/print_providers.json`);

      return response.map((p) => ({ id: p.id, title: p.title }));
    } catch {
      return [];
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
