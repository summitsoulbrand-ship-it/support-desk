/**
 * Shopify Admin API Client
 * Uses GraphQL API for efficient data fetching
 */

import {
  ShopifyConfig,
  ShopifyCustomer,
  ShopifyOrder,
  CustomerWithOrders,
} from './types';
import {
  OrderNode,
  MailingAddressInput,
  normalizeMailingAddress,
  mailingAddressForUpdate,
  mapOrderNode,
} from './mappers';
import {
  CUSTOMER_BY_EMAIL_QUERY,
  CUSTOMER_ORDERS_QUERY,
  ORDERS_BY_EMAIL_QUERY,
  ORDER_BY_ID_QUERY,
  PRODUCT_VARIANTS_QUERY,
  ORDER_UPDATE_MUTATION,
  ORDER_CANCEL_MUTATION,
  ORDER_CREATE_MUTATION,
  PRODUCT_SEARCH_QUERY,
  CUSTOMER_SEARCH_QUERY,
  DRAFT_ORDER_CREATE_MUTATION,
  DRAFT_ORDER_COMPLETE_MUTATION,
  ORDER_MARK_AS_PAID_MUTATION,
  REFUND_CREATE_MUTATION,
  ORDER_FULFILLMENT_ORDERS_QUERY,
  FULFILLMENT_CREATE_MUTATION,
  FULFILLMENT_ORDER_RELEASE_HOLD_MUTATION,
  ORDER_TRANSACTIONS_QUERY,
} from './queries';

const API_VERSION = '2025-07';


export class ShopifyClient {
  private config: ShopifyConfig;
  private baseUrl: string;

  constructor(config: ShopifyConfig) {
    this.config = config;
    this.baseUrl = `https://${config.storeDomain}/admin/api/${API_VERSION}`;
  }

  getStoreDomain(): string {
    return this.config.storeDomain;
  }

  /**
   * Execute a GraphQL query
   */
  private async graphql<T>(
    query: string,
    variables: Record<string, unknown> = {}
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.config.accessToken,
      },
      body: JSON.stringify({ query, variables }),
      // Bound the call so a slow Shopify response can't stall the live context
      // build (AI suggest, address save) or any other request. Errors here are
      // caught upstream and fall back to cached order data.
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Shopify API error: ${response.status} - ${text}`);
    }

    const data = await response.json();

    if (data.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    return data.data;
  }

  /**
   * Test API connection
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.graphql<{ shop: { name: string } }>(`
        query {
          shop {
            name
          }
        }
      `);
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error };
    }
  }

  async getShopCurrencyCode(): Promise<string | null> {
    try {
      const data = await this.graphql<{ shop: { currencyCode: string } }>(`
        query {
          shop {
            currencyCode
          }
        }
      `);
      return data.shop.currencyCode;
    } catch (err) {
      console.error('Error fetching shop currency:', err);
      return null;
    }
  }

  async getShippingRatesForCountry(country: string): Promise<{
    currencyCode?: string;
    rates: {
      id: string;
      title: string;
      price: string;
      currencyCode?: string;
      zoneName?: string;
    }[];
  }> {
    try {
      const response = await fetch(`${this.baseUrl}/shipping_zones.json`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': this.config.accessToken,
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Shopify API error: ${response.status} - ${text}`);
      }

      const data = (await response.json()) as {
        shipping_zones?: {
          id: number;
          name: string;
          countries: { id: number; name: string; code?: string }[];
          price_based_shipping_rates?: {
            id: number;
            name: string;
            price: string;
          }[];
          weight_based_shipping_rates?: {
            id: number;
            name: string;
            price: string;
          }[];
        }[];
      };

      const normalizedCountry = country.trim().toLowerCase();
      const isCode = normalizedCountry.length === 2;
      const currencyCode = await this.getShopCurrencyCode();
      const rates: {
        id: string;
        title: string;
        price: string;
        currencyCode?: string;
        zoneName?: string;
      }[] = [];

      (data.shipping_zones || []).forEach((zone) => {
        const matchesCountry = zone.countries.some((entry) => {
          if (isCode && entry.code) {
            return entry.code.toLowerCase() === normalizedCountry;
          }
          return entry.name.toLowerCase() === normalizedCountry;
        });

        if (!matchesCountry) return;

        (zone.price_based_shipping_rates || []).forEach((rate) => {
          rates.push({
            id: `price:${zone.id}:${rate.id}`,
            title: rate.name,
            price: rate.price,
            currencyCode: currencyCode || undefined,
            zoneName: zone.name,
          });
        });

        (zone.weight_based_shipping_rates || []).forEach((rate) => {
          rates.push({
            id: `weight:${zone.id}:${rate.id}`,
            title: rate.name,
            price: rate.price,
            currencyCode: currencyCode || undefined,
            zoneName: zone.name,
          });
        });
      });

      return { currencyCode: currencyCode || undefined, rates };
    } catch (err) {
      console.error('Error fetching shipping rates:', err);
      return { rates: [] };
    }
  }

  /**
   * Find customer by email address
   */
  async findCustomerByEmail(email: string): Promise<ShopifyCustomer | null> {
    try {
      interface CustomerResponse {
        customers: {
          edges: {
            node: {
              id: string;
              email: string;
              firstName?: string;
              lastName?: string;
              displayName: string;
              phone?: string;
              tags: string[];
              createdAt: string;
              note?: string;
              numberOfOrders: number;
              amountSpent: {
                amount: string;
                currencyCode: string;
              };
              defaultAddress?: {
                address1?: string;
                address2?: string;
                city?: string;
                province?: string;
                provinceCode?: string;
                country?: string;
                countryCodeV2?: string;
                zip?: string;
                phone?: string;
              };
            };
          }[];
        };
      }

      const data = await this.graphql<CustomerResponse>(
        CUSTOMER_BY_EMAIL_QUERY,
        { email: `email:${email}` }
      );

      const customerNode = data.customers.edges[0]?.node;
      if (!customerNode) {
        return null;
      }

      return {
        id: customerNode.id,
        email: customerNode.email,
        firstName: customerNode.firstName,
        lastName: customerNode.lastName,
        displayName: customerNode.displayName,
        phone: customerNode.phone,
        tags: customerNode.tags,
        totalSpent: customerNode.amountSpent.amount,
        totalSpentCurrency: customerNode.amountSpent.currencyCode,
        numberOfOrders: customerNode.numberOfOrders,
        createdAt: customerNode.createdAt,
        note: customerNode.note,
        defaultAddress: customerNode.defaultAddress
          ? {
              ...customerNode.defaultAddress,
              countryCode: customerNode.defaultAddress.countryCodeV2,
            }
          : undefined,
      };
    } catch (err) {
      console.error('Error finding customer:', err);
      return null;
    }
  }

  /**
   * Get customer orders
   */
  async getCustomerOrders(
    customerId: string,
    limit: number = 10
  ): Promise<ShopifyOrder[]> {
    try {
      interface OrdersResponse {
        customer: {
          orders: {
            edges: {
              node: {
                id: string;
                name: string;
                legacyResourceId: string;
                createdAt: string;
                updatedAt: string;
                displayFinancialStatus: string;
                displayFulfillmentStatus: string | null;
                totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
                subtotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
                totalShippingPriceSet: { shopMoney: { amount: string; currencyCode: string } };
                totalTaxSet: { shopMoney: { amount: string; currencyCode: string } };
                note?: string;
                tags: string[];
                cancelledAt?: string;
                cancelReason?: string;
    lineItems: {
      edges: {
        node: {
          id: string;
          title: string;
          variantTitle?: string;
          quantity: number;
          originalUnitPriceSet: { shopMoney: { amount: string; currencyCode: string } };
          discountAllocations?: { allocatedAmountSet: { shopMoney: { amount: string } } }[];
          sku?: string;
          image?: { url: string } | null;
          product?: { id: string };
          variant?: {
            id: string;
            image?: { url: string } | null;
            selectedOptions?: { name: string; value: string }[];
          };
        };
      }[];
    };
                fulfillments: {
                  id: string;
                  status: string;
                  trackingInfo: { number?: string; url?: string; company?: string }[];
                  createdAt: string;
                  updatedAt: string;
                  fulfillmentLineItems: {
                    edges: {
                      node: {
                        id: string;
                        quantity: number;
                        lineItem: { id: string };
                      };
                    }[];
                  };
                }[];
                shippingAddress?: {
                  address1?: string;
                  address2?: string;
                  city?: string;
                  province?: string;
                  provinceCode?: string;
                  country?: string;
                  countryCodeV2?: string;
                  zip?: string;
                  phone?: string;
                };
                billingAddress?: {
                  address1?: string;
                  address2?: string;
                  city?: string;
                  province?: string;
                  provinceCode?: string;
                  country?: string;
                  countryCodeV2?: string;
                  zip?: string;
                  phone?: string;
                };
                metafields: {
                  edges: {
                    node: {
                      key: string;
                      namespace: string;
                      value: string;
                    };
                  }[];
                };
              };
            }[];
          };
        } | null;
      }

      const data = await this.graphql<OrdersResponse>(CUSTOMER_ORDERS_QUERY, {
        customerId,
        first: limit,
      });

      if (!data.customer) {
        return [];
      }

      return data.customer.orders.edges.map((edge) =>
        mapOrderNode(edge.node as OrderNode)
      );
    } catch (err) {
      console.error('Error fetching orders:', err);
      return [];
    }
  }

  /**
   * Search orders by email (guest checkouts)
   */
  async getOrdersByEmail(
    email: string,
    limit: number = 10
  ): Promise<ShopifyOrder[]> {
    try {
      interface OrdersByEmailResponse {
        orders: {
          edges: {
            node: OrderNode;
          }[];
        };
      }

      const data = await this.graphql<OrdersByEmailResponse>(
        ORDERS_BY_EMAIL_QUERY,
        // Quoted: emails with + or unusual chars break unquoted search syntax
        { query: `email:"${email.replace(/"/g, '\\"')}"`, first: limit }
      );

      return data.orders.edges.map((edge) => mapOrderNode(edge.node));
    } catch (err) {
      console.error('Error searching orders by email:', err);
      return [];
    }
  }

  /**
   * Search orders using a raw query string (Shopify search syntax)
   */
  async getOrdersByQuery(
    query: string,
    limit: number = 10
  ): Promise<ShopifyOrder[]> {
    try {
      interface OrdersByQueryResponse {
        orders: {
          edges: {
            node: OrderNode;
          }[];
        };
      }

      const data = await this.graphql<OrdersByQueryResponse>(
        ORDERS_BY_EMAIL_QUERY,
        { query, first: limit }
      );

      return data.orders.edges.map((edge) => mapOrderNode(edge.node));
    } catch (err) {
      console.error('Error searching orders by query:', err);
      return [];
    }
  }

  /**
   * Get a single order by ID
   */
  /**
   * Batch refund status for a set of Shopify orders (by numeric id or gid).
   * Returns a map of numeric order id -> { financialStatus, totalRefunded }.
   * Used by the late-orders view to flag orders the customer was already refunded.
   */
  async getOrdersRefundStatus(
    orderIds: string[]
  ): Promise<Record<string, { financialStatus: string; totalRefunded: number }>> {
    const out: Record<string, { financialStatus: string; totalRefunded: number }> = {};
    const gids = [...new Set(orderIds.filter(Boolean))].map((id) =>
      id.startsWith('gid://') ? id : `gid://shopify/Order/${id}`
    );
    for (let i = 0; i < gids.length; i += 50) {
      const chunk = gids.slice(i, i + 50);
      try {
        const data = await this.graphql<{
          nodes: ({
            id: string;
            displayFinancialStatus: string | null;
            totalRefundedSet?: { shopMoney?: { amount?: string } } | null;
          } | null)[];
        }>(
          `query OrdersRefund($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Order {
                id
                displayFinancialStatus
                totalRefundedSet { shopMoney { amount } }
              }
            }
          }`,
          { ids: chunk }
        );
        for (const n of data.nodes || []) {
          if (!n?.id) continue;
          out[n.id.replace('gid://shopify/Order/', '')] = {
            financialStatus: n.displayFinancialStatus || '',
            totalRefunded: parseFloat(n.totalRefundedSet?.shopMoney?.amount || '0') || 0,
          };
        }
      } catch (err) {
        console.error('Error fetching refund status:', err);
      }
    }
    return out;
  }

  async getOrderById(orderId: string): Promise<ShopifyOrder | null> {
    try {
      interface OrderByIdResponse {
        order: OrderNode | null;
      }

      const data = await this.graphql<OrderByIdResponse>(ORDER_BY_ID_QUERY, {
        id: orderId,
      });

      if (!data.order) {
        return null;
      }

      return mapOrderNode(data.order);
    } catch (err) {
      console.error('Error fetching order by id:', err);
      return null;
    }
  }

  /**
   * Get product variants for replacement selection
   */
  async getProductVariants(
    productId: string,
    limit: number = 250
  ): Promise<
    | {
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
    | null
  > {
    try {
      interface ProductVariantsResponse {
        product: {
          id: string;
          title: string;
          variants: {
            pageInfo: { hasNextPage: boolean; endCursor?: string | null };
            edges: {
              node: {
                id: string;
                title: string;
                price: string;
                sku?: string;
                availableForSale: boolean;
                image?: { url: string };
                selectedOptions: { name: string; value: string }[];
              };
            }[];
          };
        } | null;
      }

      let hasNextPage = true;
      let cursor: string | null = null;
      const allVariants: {
        id: string;
        title: string;
        price: string;
        sku?: string;
        availableForSale: boolean;
        image?: { url: string };
        selectedOptions: { name: string; value: string }[];
      }[] = [];
      let productTitle = '';

      while (hasNextPage) {
        const data: ProductVariantsResponse = await this.graphql<ProductVariantsResponse>(
          PRODUCT_VARIANTS_QUERY,
          { id: productId, first: limit, after: cursor }
        );

        if (!data.product) {
          return null;
        }

        productTitle = data.product.title;
        data.product.variants.edges.forEach((edge) => {
        allVariants.push(edge.node);
        });

        hasNextPage = data.product.variants.pageInfo.hasNextPage;
        cursor = data.product.variants.pageInfo.endCursor || null;
      }

      return {
        productId,
        title: productTitle,
        variants: allVariants.map((node) => ({
          id: node.id,
          title: node.title,
          price: node.price,
          sku: node.sku,
          availableForSale: node.availableForSale,
          imageUrl: node.image?.url,
          selectedOptions: node.selectedOptions,
        })),
      };
    } catch (err) {
      console.error('Error fetching product variants:', err);
      return null;
    }
  }

  /**
   * Update order shipping address
   */
  async updateOrderShippingAddress(
    orderId: string,
    shippingAddress: {
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
  ): Promise<{ success: boolean; errors?: string[] }> {
    try {
      interface OrderUpdateResponse {
        orderUpdate: {
          order: { id: string } | null;
          userErrors: { field?: string[]; message: string }[];
        };
      }

      // Update path: keep explicitly-cleared optional fields (e.g. a removed
      // apartment number) as "" so Shopify clears them instead of retaining the
      // old value. See mailingAddressForUpdate.
      const normalizedAddress = mailingAddressForUpdate(shippingAddress);

      const data = await this.graphql<OrderUpdateResponse>(
        ORDER_UPDATE_MUTATION,
        {
          input: {
            id: orderId,
            shippingAddress: normalizedAddress,
          },
        }
      );

      const errors = data.orderUpdate.userErrors.map((e) => e.message);
      if (errors.length > 0) {
        return { success: false, errors };
      }

      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, errors: [error] };
    }
  }

  /**
   * Cancel an order with full refund
   */
  async cancelOrder(
    orderId: string,
    reason: 'CUSTOMER' | 'INVENTORY' | 'FRAUD' | 'DECLINED' | 'OTHER' | 'STAFF' = 'CUSTOMER',
    refundMethod: 'ORIGINAL' | 'STORE_CREDIT' = 'ORIGINAL',
    staffNote?: string,
    notifyCustomer: boolean = true
  ): Promise<{ success: boolean; errors?: string[] }> {
    try {
      interface OrderCancelResponse {
        orderCancel: {
          job?: { id: string; done: boolean } | null;
          orderCancelUserErrors?: {
            field?: string[] | null;
            message: string;
            code?: string | null;
          }[];
          userErrors?: { field?: string[]; message: string }[];
        };
      }

      const refundMethodInput =
        refundMethod === 'STORE_CREDIT'
          ? { storeCreditRefund: {} }
          : { originalPaymentMethodsRefund: true };

      const data = await this.graphql<OrderCancelResponse>(ORDER_CANCEL_MUTATION, {
        orderId,
        notifyCustomer,
        refundMethod: refundMethodInput,
        restock: true,
        reason,
        staffNote: staffNote || undefined,
      });

      const errors = [
        ...(data.orderCancel.orderCancelUserErrors || []).map((e) => e.message),
        ...(data.orderCancel.userErrors || []).map((e) => e.message),
      ];
      if (errors.length > 0) {
        return { success: false, errors };
      }

      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, errors: [error] };
    }
  }

  /**
   * Create a replacement order with 100% discount
   */
  async createReplacementOrder(input: {
    email?: string;
    customerId?: string;
    shippingAddress?: {
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
    };
    billingAddress?: {
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
    };
    lineItems: { variantId: string; quantity: number; requiresShipping?: boolean }[];
    note?: string;
    tags?: string[];
    discountCode?: string;
    discountType?: 'PERCENTAGE' | 'FIXED_AMOUNT';
    discountValue?: number;
    currencyCode?: string;
    shippingLine?: {
      title: string;
      price: string;
      currencyCode?: string;
    };
    taxExempt?: boolean;
  }): Promise<{ success: boolean; orderId?: string; orderName?: string; errors?: string[] }> {
    try {
      interface OrderCreateResponse {
        orderCreate: {
          order: { id: string; name: string; legacyResourceId: string } | null;
          userErrors: { field?: string[]; message: string }[];
        };
      }

      const discountType = input.discountType || 'PERCENTAGE';
      const discountValue =
        typeof input.discountValue === 'number' ? input.discountValue : 100;
      const currencyCode = input.currencyCode || 'USD';

      const discountCode =
        discountType === 'FIXED_AMOUNT'
          ? {
              itemFixedDiscountCode: {
                code:
                  input.discountCode?.toUpperCase().replace(/\s+/g, '-') ||
                  'REPLACEMENT',
                amountSet: {
                  shopMoney: {
                    amount: Math.max(discountValue, 0).toFixed(2),
                    currencyCode,
                  },
                  presentmentMoney: {
                    amount: Math.max(discountValue, 0).toFixed(2),
                    currencyCode,
                  },
                },
              },
            }
          : {
              itemPercentageDiscountCode: {
                code:
                  input.discountCode?.toUpperCase().replace(/\s+/g, '-') ||
                  'REPLACEMENT',
                percentage: Math.min(Math.max(discountValue, 0), 100),
              },
            };

      const orderInput: Record<string, unknown> = {
        email: input.email,
        customerId: input.customerId || undefined,
        shippingAddress: normalizeMailingAddress(input.shippingAddress),
        billingAddress: normalizeMailingAddress(input.billingAddress),
        lineItems: input.lineItems.map((item) => ({
          variantId: item.variantId,
          quantity: item.quantity,
          ...(typeof item.requiresShipping === 'boolean'
            ? { requiresShipping: item.requiresShipping }
            : {}),
        })),
        note: input.note,
        tags: input.tags,
        discountCode,
      };

      if (input.shippingLine) {
        const shippingCurrency = input.shippingLine.currencyCode || currencyCode;
        const amount = parseFloat(input.shippingLine.price || '0').toFixed(2);
        orderInput.shippingLines = [
          {
            title: input.shippingLine.title,
            priceSet: {
              shopMoney: {
                amount,
                currencyCode: shippingCurrency,
              },
              presentmentMoney: {
                amount,
                currencyCode: shippingCurrency,
              },
            },
          },
        ];
      }

      const data = await this.graphql<OrderCreateResponse>(ORDER_CREATE_MUTATION, {
        order: orderInput,
      });

      const errors = data.orderCreate.userErrors.map((e) => e.message);
      if (errors.length > 0) {
        return { success: false, errors };
      }

      return {
        success: true,
        orderId: data.orderCreate.order?.id,
        orderName: data.orderCreate.order?.name,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, errors: [error] };
    }
  }

  /**
   * Get customer with their orders
   */
  async getCustomerWithOrders(
    email: string,
    orderLimit: number = 10
  ): Promise<CustomerWithOrders | null> {
    const customer = await this.findCustomerByEmail(email);
    if (!customer) {
      return null;
    }

    const orders = await this.getCustomerOrders(customer.id, orderLimit);

    return { customer, orders };
  }

  /**
   * Search orders by order number (e.g., "1234" or "#1234")
   */
  /**
   * Shopify's own fulfillment tracking for an order: shipment events and the
   * estimated delivery date. Free and always current (Shopify follows
   * recognized carriers itself) - used when TrackingMore is stale/over quota.
   */
  async getOrderFulfillmentTracking(orderId: string): Promise<{
    status: string | null;
    createdAt: string | null;
    estimatedDeliveryAt: string | null;
    trackingNumber: string | null;
    trackingCompany: string | null;
    trackingUrl: string | null;
    events: { happenedAt: string; status: string }[];
  } | null> {
    try {
      const data = await this.graphql<{
        order: {
          fulfillments: Array<{
            status: string;
            createdAt: string;
            estimatedDeliveryAt: string | null;
            trackingInfo: Array<{ number: string | null; company: string | null; url: string | null }>;
            events: { edges: Array<{ node: { happenedAt: string; status: string } }> };
          }>;
        } | null;
      }>(
        `query OrderFulfillmentTracking($id: ID!) {
          order(id: $id) {
            fulfillments(first: 5) {
              status
              createdAt
              estimatedDeliveryAt
              trackingInfo(first: 3) { number company url }
              events(first: 10, sortKey: HAPPENED_AT, reverse: true) {
                edges { node { happenedAt status } }
              }
            }
          }
        }`,
        { id: orderId }
      );

      const fulfillments = data.order?.fulfillments || [];
      if (fulfillments.length === 0) return null;
      // Newest fulfillment carries the relevant shipment
      const f = [...fulfillments].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )[0];
      const tracking = f.trackingInfo[0];
      return {
        status: f.status || null,
        createdAt: f.createdAt || null,
        estimatedDeliveryAt: f.estimatedDeliveryAt || null,
        trackingNumber: tracking?.number || null,
        trackingCompany: tracking?.company || null,
        trackingUrl: tracking?.url || null,
        events: f.events.edges.map((e) => e.node),
      };
    } catch (err) {
      console.error('Error fetching fulfillment tracking:', err);
      return null;
    }
  }

  async getOrderByNumber(orderNumber: string): Promise<ShopifyOrder | null> {
    try {
      // Remove # prefix if present
      const cleanNumber = orderNumber.replace(/^#/, '');

      interface OrdersByNameResponse {
        orders: {
          edges: {
            node: OrderNode;
          }[];
        };
      }

      // Try multiple query formats - Shopify search syntax can be finicky
      const queries = [
        `name:#${cleanNumber}`,           // Standard format: name:#11737
        `name:"#${cleanNumber}"`,          // Quoted format: name:"#11737"
        cleanNumber,                        // Just the number as general search
      ];

      for (const query of queries) {
        console.log('[getOrderByNumber] Trying query:', query);
        const data = await this.graphql<OrdersByNameResponse>(
          ORDERS_BY_EMAIL_QUERY,
          { query, first: 1 }
        );
        console.log('[getOrderByNumber] Results:', data.orders.edges.length);

        if (data.orders.edges.length > 0) {
          return mapOrderNode(data.orders.edges[0].node);
        }
      }

      console.log('[getOrderByNumber] No order found for number:', orderNumber);
      return null;
    } catch (err) {
      console.error('Error searching order by number:', err);
      return null;
    }
  }

  /**
   * Search customers by name
   */
  async findCustomerByName(name: string): Promise<ShopifyCustomer | null> {
    try {
      interface CustomerResponse {
        customers: {
          edges: {
            node: {
              id: string;
              email: string;
              firstName?: string;
              lastName?: string;
              displayName: string;
              phone?: string;
              tags: string[];
              createdAt: string;
              note?: string;
              numberOfOrders: number;
              amountSpent: {
                amount: string;
                currencyCode: string;
              };
              defaultAddress?: {
                address1?: string;
                address2?: string;
                city?: string;
                province?: string;
                provinceCode?: string;
                country?: string;
                countryCodeV2?: string;
                zip?: string;
                phone?: string;
              };
            };
          }[];
        };
      }

      const cleaned = name.trim().replace(/\s+/g, ' ');
      console.log('[findCustomerByName] Searching for name:', cleaned);
      if (!cleaned) return null;

      // Try multiple search strategies for flexibility
      const searchQueries = [
        // Strategy 1: General text search (most flexible)
        cleaned,
        // Strategy 2: Search by display name
        `name:${cleaned}`,
      ];

      // Strategy 3: First/last name field search (most specific)
      const parts = cleaned.split(' ');
      if (parts.length >= 2) {
        const firstName = parts[0];
        const lastName = parts.slice(1).join(' ');
        searchQueries.push(
          `first_name:"${firstName.replace(/"/g, '\\"')}" last_name:"${lastName.replace(/"/g, '\\"')}"`
        );
      }

      for (const query of searchQueries) {
        console.log('[findCustomerByName] Trying query:', query);
        const data = await this.graphql<CustomerResponse>(
          CUSTOMER_BY_EMAIL_QUERY,
          { email: query }
        );
        console.log('[findCustomerByName] Results:', data.customers.edges.length);

        const customerNode = data.customers.edges[0]?.node;
        if (customerNode) {
          return {
            id: customerNode.id,
            email: customerNode.email,
            firstName: customerNode.firstName,
            lastName: customerNode.lastName,
            displayName: customerNode.displayName,
            phone: customerNode.phone,
            tags: customerNode.tags,
            totalSpent: customerNode.amountSpent.amount,
            totalSpentCurrency: customerNode.amountSpent.currencyCode,
            numberOfOrders: customerNode.numberOfOrders,
            createdAt: customerNode.createdAt,
            note: customerNode.note,
            defaultAddress: customerNode.defaultAddress
              ? {
                  ...customerNode.defaultAddress,
                  countryCode: customerNode.defaultAddress.countryCodeV2,
                }
              : undefined,
          };
        }
      }

      return null;
    } catch (err) {
      console.error('Error finding customer by name:', err);
      return null;
    }
  }

  /**
   * Search products by title or SKU
   */
  async searchProducts(query: string, limit: number = 10): Promise<{
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
      selectedOptions?: { name: string; value: string }[];
    }[];
  }[]> {
    try {
      interface ProductSearchResponse {
        products: {
          edges: {
            node: {
              id: string;
              title: string;
              handle: string;
              status: string;
              featuredImage?: { url: string };
              variants: {
                edges: {
                  node: {
                    id: string;
                    title: string;
                    price: string;
                    sku?: string;
                    availableForSale: boolean;
                    image?: { url: string };
                    selectedOptions?: { name: string; value: string }[];
                  };
                }[];
              };
            };
          }[];
        };
      }

      const data = await this.graphql<ProductSearchResponse>(
        PRODUCT_SEARCH_QUERY,
        { query, first: limit }
      );

      return data.products.edges.map((edge) => ({
        id: edge.node.id,
        title: edge.node.title,
        handle: edge.node.handle,
        imageUrl: edge.node.featuredImage?.url,
        variants: edge.node.variants.edges.map((v) => ({
          id: v.node.id,
          title: v.node.title,
          price: v.node.price,
          sku: v.node.sku,
          availableForSale: v.node.availableForSale,
          imageUrl: v.node.image?.url,
          selectedOptions: v.node.selectedOptions,
        })),
      }));
    } catch (err) {
      console.error('Error searching products:', err);
      return [];
    }
  }

  /**
   * Search customers by name or email
   */
  async searchCustomers(query: string, limit: number = 10): Promise<ShopifyCustomer[]> {
    try {
      interface CustomerSearchResponse {
        customers: {
          edges: {
            node: {
              id: string;
              email: string;
              displayName: string;
              phone?: string;
              tags: string[];
              createdAt: string;
              note?: string;
              numberOfOrders: number;
              amountSpent: { amount: string; currencyCode: string };
              defaultAddress?: {
                address1?: string;
                address2?: string;
                city?: string;
                province?: string;
                provinceCode?: string;
                country?: string;
                countryCodeV2?: string;
                zip?: string;
                phone?: string;
              };
            };
          }[];
        };
      }

      const data = await this.graphql<CustomerSearchResponse>(CUSTOMER_SEARCH_QUERY, {
        query,
        first: limit,
      });

      return data.customers.edges.map((edge) => ({
        id: edge.node.id,
        email: edge.node.email,
        displayName: edge.node.displayName,
        phone: edge.node.phone,
        tags: edge.node.tags,
        totalSpent: edge.node.amountSpent.amount,
        totalSpentCurrency: edge.node.amountSpent.currencyCode,
        numberOfOrders: edge.node.numberOfOrders,
        createdAt: edge.node.createdAt,
        note: edge.node.note,
        defaultAddress: edge.node.defaultAddress
          ? {
              ...edge.node.defaultAddress,
              countryCode: edge.node.defaultAddress.countryCodeV2,
            }
          : undefined,
      }));
    } catch (err) {
      console.error('Error searching customers:', err);
      return [];
    }
  }

  /**
   * Create a draft order
   */
  async createDraftOrder(input: {
    customerId?: string;
    email?: string;
    lineItems: {
      variantId: string;
      quantity: number;
      requiresShipping?: boolean;
    }[];
    shippingAddress?: MailingAddressInput & {
      name?: string;
      countryCode?: string;
      countryCodeV2?: string;
    };
    billingAddress?: MailingAddressInput & {
      name?: string;
      countryCode?: string;
      countryCodeV2?: string;
    };
    appliedDiscount?: {
      title?: string;
      value: number;
      valueType: 'FIXED_AMOUNT' | 'PERCENTAGE';
    };
    shippingLine?: {
      title: string;
      price: string;
    };
    note?: string;
    tags?: string[];
  }): Promise<{
    success: boolean;
    draftOrderId?: string;
    draftOrderName?: string;
    invoiceUrl?: string;
    errors?: string[];
  }> {
    try {
      interface DraftOrderCreateResponse {
        draftOrderCreate: {
          draftOrder: {
            id: string;
            name: string;
            legacyResourceId: string;
            invoiceUrl: string;
            status: string;
            totalPrice: string;
          } | null;
          userErrors: { field?: string[]; message: string }[];
        };
      }

      // Build the input object for the mutation
      const draftInput: Record<string, unknown> = {
        lineItems: input.lineItems.map((li) => ({
          variantId: li.variantId,
          quantity: li.quantity,
          ...(typeof li.requiresShipping === 'boolean'
            ? { requiresShipping: li.requiresShipping }
            : {}),
        })),
      };

      if (input.customerId) {
        draftInput.customerId = input.customerId;
      }
      if (input.email) {
        draftInput.email = input.email;
      }
      const shippingAddress = normalizeMailingAddress(input.shippingAddress);
      if (shippingAddress) {
        draftInput.shippingAddress = shippingAddress;
      }
      const billingAddress = normalizeMailingAddress(input.billingAddress);
      if (billingAddress) {
        draftInput.billingAddress = billingAddress;
      }
      if (input.appliedDiscount) {
        draftInput.appliedDiscount = {
          title: input.appliedDiscount.title || 'Discount',
          value: input.appliedDiscount.value,
          valueType: input.appliedDiscount.valueType,
        };
      }
      if (input.shippingLine) {
        draftInput.shippingLine = {
          title: input.shippingLine.title,
          price: input.shippingLine.price,
        };
      }
      if (input.note) {
        draftInput.note = input.note;
      }
      if (input.tags && input.tags.length > 0) {
        draftInput.tags = input.tags;
      }

      const data = await this.graphql<DraftOrderCreateResponse>(
        DRAFT_ORDER_CREATE_MUTATION,
        { input: draftInput }
      );

      if (data.draftOrderCreate.userErrors.length > 0) {
        return {
          success: false,
          errors: data.draftOrderCreate.userErrors.map((e) => e.message),
        };
      }

      const draftOrder = data.draftOrderCreate.draftOrder;
      if (!draftOrder) {
        return { success: false, errors: ['Failed to create draft order'] };
      }

      return {
        success: true,
        draftOrderId: draftOrder.id,
        draftOrderName: draftOrder.name,
        invoiceUrl: draftOrder.invoiceUrl,
      };
    } catch (err) {
      console.error('Error creating draft order:', err);
      return {
        success: false,
        errors: [err instanceof Error ? err.message : 'Unknown error'],
      };
    }
  }

  async completeDraftOrder(
    draftOrderId: string,
    paymentPending: boolean = false
  ): Promise<{
    success: boolean;
    orderId?: string;
    orderName?: string;
    displayFinancialStatus?: string;
    canMarkAsPaid?: boolean;
    totalOutstanding?: string;
    totalOutstandingCurrency?: string;
    errors?: string[];
  }> {
    try {
      interface DraftOrderCompleteResponse {
        draftOrderComplete: {
          draftOrder:
            | {
                id: string;
                order?:
                  | {
                      id: string;
                      name: string;
                      legacyResourceId: string;
                      displayFinancialStatus?: string;
                      canMarkAsPaid?: boolean;
                      totalOutstandingSet?: {
                        shopMoney: { amount: string; currencyCode: string };
                      } | null;
                    }
                  | null;
              }
            | null;
          userErrors: { field?: string[]; message: string }[];
        };
      }

      const data = await this.graphql<DraftOrderCompleteResponse>(
        DRAFT_ORDER_COMPLETE_MUTATION,
        { id: draftOrderId, paymentPending }
      );

      if (data.draftOrderComplete.userErrors.length > 0) {
        return {
          success: false,
          errors: data.draftOrderComplete.userErrors.map((e) => e.message),
        };
      }

      const order = data.draftOrderComplete.draftOrder?.order;

      return {
        success: true,
        orderId: order?.id,
        orderName: order?.name,
        displayFinancialStatus: order?.displayFinancialStatus,
        canMarkAsPaid: order?.canMarkAsPaid,
        totalOutstanding: order?.totalOutstandingSet?.shopMoney.amount,
        totalOutstandingCurrency:
          order?.totalOutstandingSet?.shopMoney.currencyCode,
      };
    } catch (err) {
      return {
        success: false,
        errors: [err instanceof Error ? err.message : 'Unknown error'],
      };
    }
  }

  async markOrderAsPaid(orderId: string): Promise<{
    success: boolean;
    displayFinancialStatus?: string;
    totalOutstanding?: string;
    totalOutstandingCurrency?: string;
    errors?: string[];
  }> {
    try {
      interface OrderMarkAsPaidResponse {
        orderMarkAsPaid: {
          order: {
            id: string;
            displayFinancialStatus?: string;
            totalOutstandingSet?: {
              shopMoney: { amount: string; currencyCode: string };
            } | null;
          } | null;
          userErrors: { field?: string[]; message: string }[];
        };
      }

      const data = await this.graphql<OrderMarkAsPaidResponse>(
        ORDER_MARK_AS_PAID_MUTATION,
        { input: { id: orderId } }
      );

      if (data.orderMarkAsPaid.userErrors.length > 0) {
        return {
          success: false,
          errors: data.orderMarkAsPaid.userErrors.map((e) => e.message),
        };
      }

      const order = data.orderMarkAsPaid.order;

      return {
        success: true,
        displayFinancialStatus: order?.displayFinancialStatus,
        totalOutstanding: order?.totalOutstandingSet?.shopMoney.amount,
        totalOutstandingCurrency:
          order?.totalOutstandingSet?.shopMoney.currencyCode,
      };
    } catch (err) {
      return {
        success: false,
        errors: [err instanceof Error ? err.message : 'Unknown error'],
      };
    }
  }

  /**
   * Get order transaction details for refund
   */
  async getOrderTransactions(orderId: string): Promise<{
    totalReceived: string;
    totalRefunded: string;
    currency: string;
    transactions: {
      id: string;
      kind: string;
      status: string;
      amount: string;
      gateway: string;
      parentId?: string;
    }[];
  } | null> {
    try {
      interface OrderTransactionsResponse {
        order: {
          id: string;
          name: string;
          totalReceivedSet: { shopMoney: { amount: string; currencyCode: string } };
          totalRefundedSet: { shopMoney: { amount: string; currencyCode: string } };
          transactions: {
            id: string;
            kind: string;
            status: string;
            amountSet: { shopMoney: { amount: string; currencyCode: string } };
            gateway: string;
            parentTransaction?: { id: string };
          }[];
        };
      }

      const data = await this.graphql<OrderTransactionsResponse>(
        ORDER_TRANSACTIONS_QUERY,
        { orderId }
      );

      if (!data.order) return null;

      return {
        totalReceived: data.order.totalReceivedSet.shopMoney.amount,
        totalRefunded: data.order.totalRefundedSet.shopMoney.amount,
        currency: data.order.totalReceivedSet.shopMoney.currencyCode,
        transactions: data.order.transactions.map((t) => ({
          id: t.id,
          kind: t.kind,
          status: t.status,
          amount: t.amountSet.shopMoney.amount,
          gateway: t.gateway,
          parentId: t.parentTransaction?.id,
        })),
      };
    } catch (err) {
      console.error('Error getting order transactions:', err);
      return null;
    }
  }

  /**
   * Refund an order
   */
  async refundOrder(
    orderId: string,
    options?: {
      amount?: string;
      reason?: string;
      refundShipping?: boolean;
      shippingAmount?: string;
      notify?: boolean;
    }
  ): Promise<{ success: boolean; refundedAmount?: string; shippingRefunded?: string; errors?: string[] }> {
    try {
      // First get the order transactions to find what can be refunded
      const txnData = await this.getOrderTransactions(orderId);
      if (!txnData) {
        return { success: false, errors: ['Could not fetch order details'] };
      }

      const received = parseFloat(txnData.totalReceived);
      const refunded = parseFloat(txnData.totalRefunded);
      const available = received - refunded;

      if (available <= 0) {
        return { success: false, errors: ['No amount available to refund'] };
      }

      // Find a successful SALE or CAPTURE transaction to refund against
      const refundableTransaction = txnData.transactions.find(
        (t) => (t.kind === 'SALE' || t.kind === 'CAPTURE') && t.status === 'SUCCESS'
      );

      if (!refundableTransaction) {
        return { success: false, errors: ['No refundable transaction found'] };
      }

      // Only set refundAmount if amount is explicitly provided (for line item refunds)
      // When refunding shipping only, we don't want to refund any line item amount
      const amountStr = options?.amount;
      const hasLineItemRefund = amountStr && parseFloat(amountStr) > 0;
      const refundAmount = hasLineItemRefund ? Math.min(parseFloat(amountStr), available) : 0;

      interface RefundCreateResponse {
        refundCreate: {
          refund: {
            id: string;
            totalRefundedSet: { shopMoney: { amount: string; currencyCode: string } };
            transactions?: {
              edges: {
                node: {
                  amountSet: { shopMoney: { amount: string; currencyCode: string } };
                };
              }[];
            };
          } | null;
          userErrors: { field?: string[]; message: string }[];
        };
      }

      // Build the refund input
      const refundInput: {
        orderId: string;
        note: string;
        notify: boolean;
        transactions?: { orderId: string; parentId: string; amount: string; kind: string; gateway: string }[];
        shipping?: { amount: string } | { fullRefund: boolean };
      } = {
        orderId,
        note: options?.reason || 'Customer service refund',
        notify: options?.notify !== false,
      };

      // Shipping portion to refund, and tell Shopify to attribute it to shipping.
      let shippingRefund = 0;
      if (options?.refundShipping) {
        if (options?.shippingAmount && parseFloat(options.shippingAmount) > 0) {
          shippingRefund = parseFloat(options.shippingAmount);
          refundInput.shipping = { amount: options.shippingAmount };
        } else {
          // Full shipping refund: look up the order's shipping cost so it can be
          // included in the transactions total below.
          const ord = await this.getOrderById(orderId);
          shippingRefund = ord?.totalShippingPrice ? parseFloat(ord.totalShippingPrice) : 0;
          refundInput.shipping = { fullRefund: true };
        }
      }

      // The transactions array is the ACTUAL money movement and Shopify REQUIRES
      // it - without it the refund is rejected ("refund line items or duties or
      // transactions or refund methods must be present"), which is why a
      // shipping-ONLY refund failed (it previously set transactions only when a
      // line-item amount was present). Refund line items + shipping together,
      // capped at what is still refundable.
      const txnTotal = Math.min(refundAmount + shippingRefund, available);
      if (txnTotal > 0) {
        refundInput.transactions = [
          {
            orderId,
            parentId: refundableTransaction.id,
            amount: txnTotal.toFixed(2),
            kind: 'REFUND',
            gateway: refundableTransaction.gateway,
          },
        ];
      }

      const data = await this.graphql<RefundCreateResponse>(REFUND_CREATE_MUTATION, {
        input: refundInput,
      });

      if (data.refundCreate.userErrors.length > 0) {
        return {
          success: false,
          errors: data.refundCreate.userErrors.map((e) => e.message),
        };
      }

      // Get the refunded amount from the response
      // totalRefundedSet includes both line items AND shipping - this is the true total
      const totalRefundedAmount = data.refundCreate.refund?.totalRefundedSet?.shopMoney?.amount;

      // Use totalRefundedSet as the primary source since it includes everything (items + shipping)
      let actualRefundedAmount: string;
      if (totalRefundedAmount && parseFloat(totalRefundedAmount) > 0) {
        actualRefundedAmount = totalRefundedAmount;
      } else if (refundAmount > 0) {
        // Fallback to calculated amount if response doesn't include it
        const shippingAmt = options?.refundShipping && options?.shippingAmount
          ? parseFloat(options.shippingAmount)
          : 0;
        actualRefundedAmount = (refundAmount + shippingAmt).toFixed(2);
      } else if (options?.refundShipping) {
        // Shipping-only refund
        actualRefundedAmount = options.shippingAmount || 'shipping';
      } else {
        actualRefundedAmount = '0.00';
      }

      return {
        success: true,
        refundedAmount: actualRefundedAmount,
        shippingRefunded: options?.refundShipping ? (options.shippingAmount || 'full') : undefined,
      };
    } catch (err) {
      console.error('Error refunding order:', err);
      return {
        success: false,
        errors: [err instanceof Error ? err.message : 'Unknown error'],
      };
    }
  }

  /**
   * Create a fulfillment on an order with tracking info.
   * Used to push tracking from a recreated Printify order back onto the
   * original Shopify order (Printify's native sync is gone after a cancel).
   * Fulfills ALL open fulfillment orders on the order.
   */
  async createFulfillment(
    orderId: string,
    input: {
      trackingNumber: string;
      carrier?: string;
      trackingUrl?: string;
      notifyCustomer?: boolean;
    }
  ): Promise<{
    success: boolean;
    fulfillmentId?: string;
    alreadyFulfilled?: boolean;
    errors?: string[];
  }> {
    try {
      const gid = orderId.startsWith('gid://') ? orderId : `gid://shopify/Order/${orderId}`;

      // Release any holds first so the fulfillment orders are OPEN
      await this.releaseOrderHold(gid);

      interface FulfillmentOrdersResponse {
        order: {
          id: string;
          fulfillmentOrders: {
            edges: {
              node: { id: string; status: string; requestStatus: string };
            }[];
          };
        } | null;
      }

      const orderData = await this.graphql<FulfillmentOrdersResponse>(
        ORDER_FULFILLMENT_ORDERS_QUERY,
        { orderId: gid }
      );

      if (!orderData.order) {
        return { success: false, errors: ['Order not found'] };
      }

      const fulfillmentOrders = orderData.order.fulfillmentOrders.edges.map((e) => e.node);
      const fulfillable = fulfillmentOrders.filter(
        (fo) => fo.status === 'OPEN' || fo.status === 'IN_PROGRESS' || fo.status === 'SCHEDULED'
      );

      if (fulfillable.length === 0) {
        const allClosed =
          fulfillmentOrders.length > 0 &&
          fulfillmentOrders.every((fo) => fo.status === 'CLOSED');
        if (allClosed) {
          return { success: true, alreadyFulfilled: true };
        }
        return {
          success: false,
          errors: [
            `No fulfillable fulfillment orders (statuses: ${fulfillmentOrders
              .map((fo) => fo.status)
              .join(', ') || 'none'})`,
          ],
        };
      }

      interface FulfillmentCreateResponse {
        fulfillmentCreate: {
          fulfillment: { id: string; status: string } | null;
          userErrors: { field: string[] | null; message: string }[];
        };
      }

      const result = await this.graphql<FulfillmentCreateResponse>(
        FULFILLMENT_CREATE_MUTATION,
        {
          fulfillment: {
            lineItemsByFulfillmentOrder: fulfillable.map((fo) => ({
              fulfillmentOrderId: fo.id,
            })),
            trackingInfo: {
              number: input.trackingNumber,
              company: input.carrier,
              url: input.trackingUrl,
            },
            notifyCustomer: input.notifyCustomer ?? true,
          },
        }
      );

      const userErrors = result.fulfillmentCreate.userErrors;
      if (userErrors.length > 0) {
        return { success: false, errors: userErrors.map((e) => e.message) };
      }

      return {
        success: true,
        fulfillmentId: result.fulfillmentCreate.fulfillment?.id,
      };
    } catch (err) {
      console.error('Error creating fulfillment:', err);
      return {
        success: false,
        errors: [err instanceof Error ? err.message : 'Unknown error'],
      };
    }
  }

  /**
   * Release fulfillment holds on an order
   * This removes any holds placed on the order's fulfillment orders
   */
  async releaseOrderHold(orderId: string): Promise<{
    success: boolean;
    releasedCount: number;
    errors?: string[];
  }> {
    try {
      // Ensure orderId is in GID format
      const gid = orderId.startsWith('gid://') ? orderId : `gid://shopify/Order/${orderId}`;

      // Get fulfillment orders for this order
      interface FulfillmentOrdersResponse {
        order: {
          id: string;
          fulfillmentOrders: {
            edges: {
              node: {
                id: string;
                status: string;
                requestStatus: string;
              };
            }[];
          };
        } | null;
      }

      const orderData = await this.graphql<FulfillmentOrdersResponse>(ORDER_FULFILLMENT_ORDERS_QUERY, {
        orderId: gid,
      });

      if (!orderData.order) {
        return {
          success: false,
          releasedCount: 0,
          errors: ['Order not found'],
        };
      }

      const fulfillmentOrders = orderData.order.fulfillmentOrders.edges;

      // Find fulfillment orders that are on hold
      const onHoldOrders = fulfillmentOrders.filter(
        (fo) => fo.node.status === 'ON_HOLD' || fo.node.requestStatus === 'ON_HOLD'
      );

      if (onHoldOrders.length === 0) {
        return {
          success: true,
          releasedCount: 0,
        };
      }

      // Release hold on each fulfillment order
      interface ReleaseHoldResponse {
        fulfillmentOrderReleaseHold: {
          fulfillmentOrder: { id: string; status: string } | null;
          userErrors: { field: string; message: string }[];
        };
      }

      let releasedCount = 0;
      const errors: string[] = [];

      for (const fo of onHoldOrders) {
        const releaseData = await this.graphql<ReleaseHoldResponse>(FULFILLMENT_ORDER_RELEASE_HOLD_MUTATION, {
          id: fo.node.id,
        });

        if (releaseData.fulfillmentOrderReleaseHold.userErrors.length > 0) {
          errors.push(...releaseData.fulfillmentOrderReleaseHold.userErrors.map((e) => e.message));
        } else if (releaseData.fulfillmentOrderReleaseHold.fulfillmentOrder) {
          releasedCount++;
        }
      }

      return {
        success: errors.length === 0,
        releasedCount,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (err) {
      console.error('Error releasing order hold:', err);
      return {
        success: false,
        releasedCount: 0,
        errors: [err instanceof Error ? err.message : 'Unknown error'],
      };
    }
  }

  /**
   * Edit an existing order - add/remove/modify line items
   */
  async editOrder(input: {
    orderId: string;
    addItems?: { variantId: string; quantity: number; discount?: string }[];
    removeLineItemIds?: string[];
    updateQuantities?: { lineItemId: string; quantity: number }[];
    notifyCustomer?: boolean;
    staffNote?: string;
  }): Promise<{
    success: boolean;
    orderId?: string;
    orderName?: string;
    errors?: string[];
  }> {
    try {
      // Step 1: Begin the order edit
      const ORDER_EDIT_BEGIN = `
        mutation orderEditBegin($id: ID!) {
          orderEditBegin(id: $id) {
            calculatedOrder {
              id
              lineItems(first: 50) {
                nodes {
                  id
                  quantity
                  variant {
                    id
                  }
                }
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      interface OrderEditBeginResponse {
        orderEditBegin: {
          calculatedOrder: {
            id: string;
            lineItems: {
              nodes: {
                id: string;
                quantity: number;
                variant: { id: string } | null;
              }[];
            };
          } | null;
          userErrors: { field?: string[]; message: string }[];
        };
      }

      const beginResult = await this.graphql<OrderEditBeginResponse>(
        ORDER_EDIT_BEGIN,
        { id: input.orderId }
      );

      if (beginResult.orderEditBegin.userErrors.length > 0) {
        return {
          success: false,
          errors: beginResult.orderEditBegin.userErrors.map((e) => e.message),
        };
      }

      const calculatedOrder = beginResult.orderEditBegin.calculatedOrder;
      if (!calculatedOrder) {
        return { success: false, errors: ['Failed to begin order edit'] };
      }

      const calculatedOrderId = calculatedOrder.id;

      // Step 2: Remove line items (set quantity to 0)
      if (input.removeLineItemIds && input.removeLineItemIds.length > 0) {
        const ORDER_EDIT_SET_QUANTITY = `
          mutation orderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
            orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
              calculatedOrder {
                id
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

        // Find calculated line item IDs for the items we want to remove
        for (const lineItemId of input.removeLineItemIds) {
          // Find the matching calculated line item
          const calcLineItem = calculatedOrder.lineItems.nodes.find(
            (li) => li.variant?.id === lineItemId || li.id.includes(lineItemId.replace('gid://shopify/LineItem/', ''))
          );

          if (calcLineItem) {
            const removeResult = await this.graphql<{
              orderEditSetQuantity: {
                userErrors: { message: string }[];
              };
            }>(ORDER_EDIT_SET_QUANTITY, {
              id: calculatedOrderId,
              lineItemId: calcLineItem.id,
              quantity: 0,
            });

            if (removeResult.orderEditSetQuantity.userErrors.length > 0) {
              return {
                success: false,
                errors: removeResult.orderEditSetQuantity.userErrors.map((e) => e.message),
              };
            }
          }
        }
      }

      // Step 3: Update quantities
      if (input.updateQuantities && input.updateQuantities.length > 0) {
        const ORDER_EDIT_SET_QUANTITY = `
          mutation orderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
            orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
              calculatedOrder {
                id
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

        for (const update of input.updateQuantities) {
          const calcLineItem = calculatedOrder.lineItems.nodes.find(
            (li) => li.id.includes(update.lineItemId.replace('gid://shopify/LineItem/', ''))
          );

          if (calcLineItem) {
            const updateResult = await this.graphql<{
              orderEditSetQuantity: {
                userErrors: { message: string }[];
              };
            }>(ORDER_EDIT_SET_QUANTITY, {
              id: calculatedOrderId,
              lineItemId: calcLineItem.id,
              quantity: update.quantity,
            });

            if (updateResult.orderEditSetQuantity.userErrors.length > 0) {
              return {
                success: false,
                errors: updateResult.orderEditSetQuantity.userErrors.map((e) => e.message),
              };
            }
          }
        }
      }

      // Step 4: Add new items
      if (input.addItems && input.addItems.length > 0) {
        const ORDER_EDIT_ADD_VARIANT = `
          mutation orderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
            orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity) {
              calculatedLineItem {
                id
              }
              calculatedOrder {
                id
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

        const ORDER_EDIT_ADD_DISCOUNT = `
          mutation orderEditAddLineItemDiscount($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
            orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
              calculatedOrder {
                id
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

        for (const item of input.addItems) {
          const addResult = await this.graphql<{
            orderEditAddVariant: {
              calculatedLineItem: { id: string } | null;
              userErrors: { message: string }[];
            };
          }>(ORDER_EDIT_ADD_VARIANT, {
            id: calculatedOrderId,
            variantId: item.variantId,
            quantity: item.quantity,
          });

          if (addResult.orderEditAddVariant.userErrors.length > 0) {
            return {
              success: false,
              errors: addResult.orderEditAddVariant.userErrors.map((e) => e.message),
            };
          }

          // Apply discount if specified
          if (item.discount && parseFloat(item.discount) > 0 && addResult.orderEditAddVariant.calculatedLineItem) {
            const discountResult = await this.graphql<{
              orderEditAddLineItemDiscount: {
                userErrors: { message: string }[];
              };
            }>(ORDER_EDIT_ADD_DISCOUNT, {
              id: calculatedOrderId,
              lineItemId: addResult.orderEditAddVariant.calculatedLineItem.id,
              discount: {
                fixedValue: { amount: item.discount, currencyCode: 'USD' },
                description: 'Size exchange adjustment',
              },
            });

            if (discountResult.orderEditAddLineItemDiscount.userErrors.length > 0) {
              console.warn('Failed to apply discount:', discountResult.orderEditAddLineItemDiscount.userErrors);
              // Continue without failing - discount is optional
            }
          }
        }
      }

      // Step 5: Commit the changes
      const ORDER_EDIT_COMMIT = `
        mutation orderEditCommit($id: ID!, $notifyCustomer: Boolean, $staffNote: String) {
          orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
            order {
              id
              name
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const commitResult = await this.graphql<{
        orderEditCommit: {
          order: { id: string; name: string } | null;
          userErrors: { message: string }[];
        };
      }>(ORDER_EDIT_COMMIT, {
        id: calculatedOrderId,
        notifyCustomer: input.notifyCustomer ?? false,
        staffNote: input.staffNote,
      });

      if (commitResult.orderEditCommit.userErrors.length > 0) {
        return {
          success: false,
          errors: commitResult.orderEditCommit.userErrors.map((e) => e.message),
        };
      }

      return {
        success: true,
        orderId: commitResult.orderEditCommit.order?.id,
        orderName: commitResult.orderEditCommit.order?.name,
      };
    } catch (err) {
      console.error('Error editing order:', err);
      return {
        success: false,
        errors: [err instanceof Error ? err.message : 'Unknown error'],
      };
    }
  }

  /**
   * Lightweight order summaries (created date, tags, line item titles +
   * quantities) for a window, paginated. Used by the insights dashboard to
   * compute per-product sales and replacement rates without heavy payloads.
   */
  async getOrderLineItemSummaries(
    sinceISO: string,
    maxOrders = 4000
  ): Promise<
    { createdAt: string; tags: string[]; lineItems: { title: string; quantity: number }[] }[]
  > {
    // Newest first, so if the cap is hit we truncate the OLD end of the
    // window, not the current period (the store does thousands of orders/month)
    const query = `
      query OrderSummaries($q: String!, $after: String) {
        orders(first: 100, query: $q, after: $after, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              createdAt
              tags
              lineItems(first: 10) {
                edges { node { title quantity } }
              }
            }
          }
        }
      }
    `;

    const out: {
      createdAt: string;
      tags: string[];
      lineItems: { title: string; quantity: number }[];
    }[] = [];
    let after: string | null = null;

    try {
      while (out.length < maxOrders) {
        const data: {
          orders: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            edges: {
              node: {
                createdAt: string;
                tags: string[];
                lineItems: { edges: { node: { title: string; quantity: number } }[] };
              };
            }[];
          };
        } = await this.graphql(query, {
          q: `created_at:>='${sinceISO}'`,
          after,
        });

        for (const edge of data.orders.edges) {
          out.push({
            createdAt: edge.node.createdAt,
            tags: edge.node.tags || [],
            lineItems: edge.node.lineItems.edges.map((e) => e.node),
          });
        }

        if (!data.orders.pageInfo.hasNextPage) break;
        after = data.orders.pageInfo.endCursor;
      }
    } catch (err) {
      console.error('Error fetching order summaries:', err);
    }

    return out;
  }

  /**
   * All replacement-tagged orders since a date (tags + note + line items).
   * Small result set, so one tag-filtered query instead of scanning all orders.
   */
  async getReplacementOrders(
    sinceISO: string
  ): Promise<
    {
      createdAt: string;
      tags: string[];
      note: string | null;
      billingFirstName: string | null;
      lineItems: { title: string; quantity: number }[];
    }[]
  > {
    const query = `
      query ReplacementOrders($q: String!, $after: String) {
        orders(first: 100, query: $q, after: $after, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              createdAt
              tags
              note
              billingAddress { firstName }
              shippingAddress { firstName }
              lineItems(first: 10) {
                edges { node { title quantity } }
              }
            }
          }
        }
      }
    `;

    const out: {
      createdAt: string;
      tags: string[];
      note: string | null;
      billingFirstName: string | null;
      lineItems: { title: string; quantity: number }[];
    }[] = [];
    let after: string | null = null;

    try {
      for (let page = 0; page < 10; page++) {
        const data: {
          orders: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            edges: {
              node: {
                createdAt: string;
                tags: string[];
                note: string | null;
                billingAddress: { firstName: string | null } | null;
                shippingAddress: { firstName: string | null } | null;
                lineItems: { edges: { node: { title: string; quantity: number } }[] };
              };
            }[];
          };
        } = await this.graphql(query, {
          q: `tag:Replacement created_at:>=${sinceISO}`,
          after,
        });

        for (const edge of data.orders.edges) {
          out.push({
            createdAt: edge.node.createdAt,
            tags: edge.node.tags || [],
            note: edge.node.note,
            billingFirstName:
              edge.node.billingAddress?.firstName ||
              edge.node.shippingAddress?.firstName ||
              null,
            lineItems: edge.node.lineItems.edges.map((e) => e.node),
          });
        }

        if (!data.orders.pageInfo.hasNextPage) break;
        after = data.orders.pageInfo.endCursor;
      }
    } catch (err) {
      console.error('Error fetching replacement orders:', err);
    }

    return out;
  }

  /**
   * Look up a discount code's value, to honor a "my code didn't apply" request
   * by refunding the equivalent amount. Returns null if not found or the token
   * lacks read_discounts.
   */
  async lookupDiscountByCode(code: string): Promise<
    | { title: string; valueType: 'percentage'; percentage: number }
    | { title: string; valueType: 'fixed'; amount: string; currencyCode: string }
    | null
  > {
    const query = `
      query LookupDiscount($code: String!) {
        codeDiscountNodeByCode(code: $code) {
          codeDiscount {
            __typename
            ... on DiscountCodeBasic {
              title
              customerGets {
                value {
                  __typename
                  ... on DiscountPercentage { percentage }
                  ... on DiscountAmount { amount { amount currencyCode } }
                }
              }
            }
          }
        }
      }
    `;
    try {
      const data = await this.graphql<{
        codeDiscountNodeByCode: {
          codeDiscount: {
            __typename: string;
            title?: string;
            customerGets?: {
              value: {
                __typename: string;
                percentage?: number;
                amount?: { amount: string; currencyCode: string };
              };
            };
          };
        } | null;
      }>(query, { code });

      const cd = data.codeDiscountNodeByCode?.codeDiscount;
      const value = cd?.customerGets?.value;
      if (!value) return null;

      if (value.__typename === 'DiscountPercentage' && typeof value.percentage === 'number') {
        return {
          title: cd?.title || code,
          valueType: 'percentage',
          percentage: value.percentage, // 0..1
        };
      }
      if (value.__typename === 'DiscountAmount' && value.amount) {
        return {
          title: cd?.title || code,
          valueType: 'fixed',
          amount: value.amount.amount,
          currencyCode: value.amount.currencyCode,
        };
      }
      return null;
    } catch (err) {
      console.error('Error looking up discount code (read_discounts scope?):', err);
      return null;
    }
  }

  /**
   * Fetch published Online Store pages (FAQ, size guide, about, etc.)
   * Used to give the AI access to the store's own content. Returns [] if the
   * access token lacks the read_content scope.
   */
  async getPages(limit = 50): Promise<
    { title: string; handle: string; body: string }[]
  > {
    const query = `
      query StorePages($first: Int!) {
        pages(first: $first) {
          edges { node { title handle body } }
        }
      }
    `;
    try {
      const data = await this.graphql<{
        pages: { edges: { node: { title: string; handle: string; body: string } }[] };
      }>(query, { first: limit });
      return data.pages.edges.map((e) => e.node);
    } catch (err) {
      console.error('Error fetching Shopify pages (read_content scope?):', err);
      return [];
    }
  }

  /**
   * Fetch the shop's legal policies (refund, shipping, privacy, terms).
   * Returns [] if the token lacks the read_legal_policies scope.
   */
  async getShopPolicies(): Promise<
    { type: string; title: string; body: string; url: string }[]
  > {
    const query = `
      query ShopPolicies {
        shop {
          shopPolicies { type title body url }
        }
      }
    `;
    try {
      const data = await this.graphql<{
        shop: { shopPolicies: { type: string; title: string; body: string; url: string }[] };
      }>(query);
      return (data.shop.shopPolicies || []).filter((p) => p.body && p.body.trim().length > 0);
    } catch (err) {
      console.error('Error fetching Shopify policies (read_legal_policies scope?):', err);
      return [];
    }
  }

  /**
   * The public storefront origin (e.g. https://summitsoul.shop), for building
   * customer-facing product/collection links. Falls back to the myshopify URL.
   */
  async getPrimaryDomain(): Promise<string> {
    try {
      const data = await this.graphql<{ shop: { primaryDomain: { url: string } } }>(
        `query { shop { primaryDomain { url } } }`
      );
      return data.shop.primaryDomain.url.replace(/\/$/, '');
    } catch {
      return `https://${this.config.storeDomain}`;
    }
  }

  /**
   * Storefront collections (Long Sleeves, Kids, Hoodies, ...) for linking.
   */
  async getCollections(limit = 100): Promise<{ title: string; handle: string }[]> {
    try {
      const data = await this.graphql<{
        collections: { edges: { node: { title: string; handle: string } }[] };
      }>(
        `query Collections($first: Int!) {
          collections(first: $first) { edges { node { title handle } } }
        }`,
        { first: limit }
      );
      return data.collections.edges.map((e) => e.node);
    } catch (err) {
      console.error('Error fetching Shopify collections:', err);
      return [];
    }
  }

  /**
   * Active (published) products for linking specific items in replies.
   */
  async getActiveProducts(
    limit = 200
  ): Promise<{ title: string; handle: string; productType: string }[]> {
    try {
      const data = await this.graphql<{
        products: { edges: { node: { title: string; handle: string; productType: string } }[] };
      }>(
        `query Products($first: Int!) {
          products(first: $first, query: "status:active") {
            edges { node { title handle productType } }
          }
        }`,
        { first: limit }
      );
      return data.products.edges.map((e) => e.node);
    } catch (err) {
      console.error('Error fetching Shopify products:', err);
      return [];
    }
  }
}
