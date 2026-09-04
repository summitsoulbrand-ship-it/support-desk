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
  ORDER_CANCEL_JOB_QUERY,
  ORDER_CANCELLED_CHECK_QUERY,
  ORDER_CREATE_MUTATION,
  PRODUCT_SEARCH_QUERY,
  CUSTOMER_SEARCH_QUERY,
  DRAFT_ORDER_CREATE_MUTATION,
  DRAFT_ORDER_COMPLETE_MUTATION,
  ORDER_MARK_AS_PAID_MUTATION,
  REFUND_CREATE_MUTATION,
  ORDER_FULFILLMENT_ORDERS_QUERY,
  ORDER_FULFILLMENTS_QUERY,
  FULFILLMENT_CREATE_MUTATION,
  FULFILLMENT_TRACKING_UPDATE_MUTATION,
  FULFILLMENT_ORDER_RELEASE_HOLD_MUTATION,
  ORDER_TRANSACTIONS_QUERY,
} from './queries';
import { allocateRefundTransactions } from './refund-allocation';

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
  /**
   * How many orders match a query. Used for rates (e.g. what share of orders
   * took the upsell) where pulling the orders themselves would be waste.
   */
  async countOrders(query: string): Promise<number | null> {
    try {
      const data = await this.graphql<{ ordersCount: { count: number } }>(
        `query OrdersCount($query: String!) { ordersCount(query: $query) { count } }`,
        { query }
      );
      return data.ordersCount?.count ?? null;
    } catch (err) {
      console.error('Error counting orders:', err);
      return null;
    }
  }

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
   * Email the customer Shopify's own invoice / payment link for an order's
   * outstanding balance (used after an order edit adds a pricier item).
   * Shopify hosts the payment page, so no card data ever touches us.
   */
  async sendOrderInvoice(
    orderId: string,
    customMessage?: string
  ): Promise<{ success: boolean; errors?: string[] }> {
    try {
      interface OrderInvoiceSendResponse {
        orderInvoiceSend: {
          order: { id: string } | null;
          userErrors: { field?: string[]; message: string }[];
        };
      }
      const data = await this.graphql<OrderInvoiceSendResponse>(
        `
        mutation orderInvoiceSend($id: ID!, $email: EmailInput) {
          orderInvoiceSend(id: $id, email: $email) {
            order { id }
            userErrors { field message }
          }
        }
      `,
        {
          id: orderId,
          email: customMessage ? { customMessage } : undefined,
        }
      );
      const errors = data.orderInvoiceSend.userErrors.map((e) => e.message);
      if (errors.length > 0) return { success: false, errors };
      return { success: true };
    } catch (err) {
      return {
        success: false,
        errors: [err instanceof Error ? err.message : 'Unknown error'],
      };
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

      // orderCancel is ASYNCHRONOUS: Shopify accepts the request and does the
      // cancel + refund in a background Job. Returning success here on an empty
      // userErrors list is what let order #33185 (2026-08-06) end up with its
      // Printify job cancelled, the customer told they were refunded, and $78.08
      // still captured - the self-service flow cancels Printify FIRST, so a
      // silent failure here is unrecoverable for the customer. Wait for the job
      // and confirm against the order itself before claiming success.
      const jobId = data.orderCancel.job?.id;
      if (jobId && !data.orderCancel.job?.done) {
        interface JobResponse {
          job?: { id: string; done: boolean } | null;
        }
        const deadline = Date.now() + 30_000;
        let done = false;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1_000));
          try {
            const j = await this.graphql<JobResponse>(ORDER_CANCEL_JOB_QUERY, {
              id: jobId,
            });
            if (j.job?.done) {
              done = true;
              break;
            }
          } catch {
            // transient read failure - the order re-check below is the real gate
          }
        }
        if (!done) {
          console.warn(
            `[Shopify] orderCancel job ${jobId} not done after 30s for ${orderId}`
          );
        }
      }

      // Ground truth: Shopify's own record. A job can finish having done nothing.
      interface CancelledCheck {
        order?: {
          cancelledAt?: string | null;
          displayFinancialStatus?: string | null;
        } | null;
      }
      try {
        const check = await this.graphql<CancelledCheck>(
          ORDER_CANCELLED_CHECK_QUERY,
          { id: orderId }
        );
        if (!check.order?.cancelledAt) {
          return {
            success: false,
            errors: [
              'Shopify accepted the cancel but the order is still not cancelled ' +
                `(job ${jobId || 'n/a'}, financial status ` +
                `${check.order?.displayFinancialStatus || 'unknown'}). ` +
                'The customer has NOT been refunded.',
            ],
          };
        }
      } catch (err) {
        // Cannot confirm - fail loudly rather than tell a customer they are refunded.
        const msg = err instanceof Error ? err.message : 'unknown error';
        return {
          success: false,
          errors: [`Could not confirm the cancel landed on Shopify: ${msg}`],
        };
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
      const cleanNumber = orderNumber.replace(/^#/, '').trim();

      // Customers often paste more than the bare number (e.g. an email subject
      // line like "Order #24659 confirmed"). Extract the numeric core so the
      // lookup still works. Falls back to the cleaned input if no digits found.
      const digits = (orderNumber.match(/\d{3,}/) || [])[0] || cleanNumber;

      interface OrdersByNameResponse {
        orders: {
          edges: {
            node: OrderNode;
          }[];
        };
      }

      // Try multiple query formats - Shopify search syntax can be finicky.
      // Dedupe so we don't fire the same query twice when input was already clean.
      const queries = [...new Set([
        `name:#${digits}`,                 // Standard format: name:#11737
        `name:"#${digits}"`,                // Quoted format: name:"#11737"
        digits,                             // Just the number as general search
        `name:#${cleanNumber}`,             // Fall back to the raw cleaned input
        cleanNumber,
      ])];

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
   * Read an order's current outstanding balance (amount still owed after
   * edits/refunds). Used to detect and snap the tiny tax-rounding penny a
   * free pre-production size change can leave behind. Returns null on error
   * so callers fail safe (do nothing) rather than acting on a bad read.
   */
  async getOrderOutstanding(orderId: string): Promise<{
    amount: number;
    canMarkAsPaid: boolean;
    displayFinancialStatus?: string;
  } | null> {
    try {
      const data = await this.graphql<{
        order: {
          canMarkAsPaid?: boolean;
          displayFinancialStatus?: string;
          totalOutstandingSet?: { shopMoney: { amount: string } } | null;
        } | null;
      }>(
        `query($id: ID!) {
          order(id: $id) {
            canMarkAsPaid
            displayFinancialStatus
            totalOutstandingSet { shopMoney { amount } }
          }
        }`,
        { id: orderId }
      );
      if (!data.order) return null;
      return {
        amount: parseFloat(data.order.totalOutstandingSet?.shopMoney.amount || '0'),
        canMarkAsPaid: data.order.canMarkAsPaid ?? false,
        displayFinancialStatus: data.order.displayFinancialStatus,
      };
    } catch (err) {
      console.error('Error reading order outstanding balance:', err);
      return null;
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
      /**
       * ORIGINAL (default) sends the money back to the card they paid with.
       * STORE_CREDIT moves NO money - it issues spendable credit on the
       * customer's account instead. See the store-credit block below.
       */
      refundMethod?: 'ORIGINAL' | 'STORE_CREDIT';
      /** ISO date. Omit for store credit that never expires (our default). */
      storeCreditExpiresAt?: string;
    }
  ): Promise<{
    success: boolean;
    refundedAmount?: string;
    shippingRefunded?: string;
    /** True when the value went out as store credit rather than to the card. */
    storeCredit?: boolean;
    errors?: string[];
  }> {
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

      const asStoreCredit = options?.refundMethod === 'STORE_CREDIT';

      // Need at least one successful SALE/CAPTURE to refund against. Store
      // credit creates no gateway transaction, so it has no parent to attach
      // to - the available-amount check above is the real guard there.
      const hasRefundableTransaction = txnData.transactions.some(
        (t) => (t.kind === 'SALE' || t.kind === 'CAPTURE') && t.status === 'SUCCESS'
      );

      if (!asStoreCredit && !hasRefundableTransaction) {
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
        refundMethods?: {
          storeCreditRefund: {
            amount: { amount: string; currencyCode: string };
            expiresAt?: string;
          };
        }[];
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
      //
      // Allocate across EVERY refundable tender: a split-tender order (gift card
      // + card) can't refund more than one tender's own amount against that
      // tender, so a large refund is spread over parents. allocateRefundTransactions
      // caps at the per-parent headroom, so it never exceeds the order-level
      // available amount either.
      const txnTotal = Math.min(refundAmount + shippingRefund, available);

      if (asStoreCredit) {
        // Shopify issues store credit through refundMethods with an EMPTY
        // transactions array - that empty array IS the "refund without moving
        // money" mechanism (Admin API 2025-07). No dummy gateway transaction,
        // and no separate storeCreditAccountCredit call: this one mutation
        // both restocks/marks the order refunded AND credits the customer.
        if (txnTotal <= 0) {
          return { success: false, errors: ['Nothing to issue as store credit'] };
        }

        // Store credit is held against a CUSTOMER account. A guest-checkout
        // order has none, and checkout login is optional on this store, so
        // this is a real case - fail loudly rather than silently falling back
        // to a card refund, which is the bug this whole feature replaces.
        const order = await this.getOrderById(orderId);
        if (!order?.customerId) {
          return {
            success: false,
            errors: [
              'This order has no customer account, so Shopify has nowhere to hold store credit. Refund to the original payment method instead.',
            ],
          };
        }

        refundInput.transactions = [];
        refundInput.refundMethods = [
          {
            storeCreditRefund: {
              amount: {
                amount: txnTotal.toFixed(2),
                currencyCode: txnData.currency,
              },
              ...(options?.storeCreditExpiresAt
                ? { expiresAt: options.storeCreditExpiresAt }
                : {}),
            },
          },
        ];
      } else if (txnTotal > 0) {
        const allocations = allocateRefundTransactions(txnData.transactions, txnTotal);
        if (allocations.length === 0) {
          return { success: false, errors: ['No refundable transaction found'] };
        }
        refundInput.transactions = allocations.map((a) => ({
          orderId,
          parentId: a.parentId,
          amount: a.amount,
          kind: 'REFUND',
          gateway: a.gateway,
        }));
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
        storeCredit: asStoreCredit,
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
   * Replace the tracking on an order that has ALREADY shipped (a lost order
   * being reshipped): find its live fulfillment and update the tracking number,
   * notifying the customer. Acts only on the given order's own fulfillment.
   */
  async updateFulfillmentTracking(
    orderId: string,
    input: {
      trackingNumber: string;
      carrier?: string;
      trackingUrl?: string;
      notifyCustomer?: boolean;
    }
  ): Promise<{ success: boolean; fulfillmentId?: string; errors?: string[] }> {
    try {
      const gid = orderId.startsWith('gid://')
        ? orderId
        : `gid://shopify/Order/${orderId}`;

      interface OrderFulfillmentsResponse {
        order: {
          id: string;
          fulfillments: {
            id: string;
            status: string;
            createdAt: string;
            trackingInfo: { number: string | null }[];
          }[];
        } | null;
      }

      const data = await this.graphql<OrderFulfillmentsResponse>(
        ORDER_FULFILLMENTS_QUERY,
        { orderId: gid }
      );
      if (!data.order) {
        return { success: false, errors: ['Order not found'] };
      }

      // Update the newest SUCCESS fulfillment - that's the shipment the (lost)
      // tracking is on. CANCELLED fulfillments are skipped.
      const live = data.order.fulfillments
        .filter((f) => f.status === 'SUCCESS')
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      if (!live) {
        return {
          success: false,
          errors: ['No shipped fulfillment found to update tracking on'],
        };
      }

      interface TrackingUpdateResponse {
        fulfillmentTrackingInfoUpdate: {
          fulfillment: { id: string; status: string } | null;
          userErrors: { field: string[] | null; message: string }[];
        };
      }

      const result = await this.graphql<TrackingUpdateResponse>(
        FULFILLMENT_TRACKING_UPDATE_MUTATION,
        {
          fulfillmentId: live.id,
          trackingInfoInput: {
            number: input.trackingNumber,
            company: input.carrier,
            url: input.trackingUrl,
          },
          notifyCustomer: input.notifyCustomer ?? true,
        }
      );

      const userErrors = result.fulfillmentTrackingInfoUpdate.userErrors;
      if (userErrors.length > 0) {
        return { success: false, errors: userErrors.map((e) => e.message) };
      }

      return {
        success: true,
        fulfillmentId: result.fulfillmentTrackingInfoUpdate.fulfillment?.id,
      };
    } catch (err) {
      console.error('Error updating fulfillment tracking:', err);
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
   * Dry-run a one-line swap through Shopify's order-edit calculator WITHOUT
   * committing, and return the exact new order total. This is the ONLY honest
   * source for what a swap really costs the customer: Shopify recalculates
   * tax on the edited line and applies discount codes by its own rules
   * (percentage codes re-apply, fixed-amount codes don't stretch), which no
   * local math can predict. The uncommitted edit session simply expires -
   * no side effects.
   */
  async previewOrderEditSwap(input: {
    orderId: string;
    /** One or more line swaps to preview together (net total). */
    changes: {
      removeLineItemId: string;
      addVariantId: string;
      quantity: number;
      /** Fixed line discount for the added line (the absorb) */
      discount?: string;
    }[];
    /** Order currency, required when any discount is set */
    currencyCode?: string;
  }): Promise<{
    success: boolean;
    /** Exact order total AFTER all swaps (incl. tax/discount recalcs) */
    newTotalPrice?: string;
    errors?: string[];
  }> {
    if (!input.changes || input.changes.length === 0) {
      return { success: false, errors: ['No changes to preview'] };
    }
    const TOTALS = `calculatedOrder { id totalPriceSet { shopMoney { amount } } }`;
    try {
      // 1) Begin the calculated session.
      const begin = await this.graphql<{
        orderEditBegin: {
          calculatedOrder: {
            id: string;
            lineItems: { nodes: { id: string; quantity: number }[] };
          } | null;
          userErrors: { message: string }[];
        };
      }>(
        `mutation($id: ID!) { orderEditBegin(id: $id) {
          calculatedOrder { id lineItems(first: 50) { nodes { id quantity } } }
          userErrors { message } } }`,
        { id: input.orderId }
      );
      if (begin.orderEditBegin.userErrors.length > 0 || !begin.orderEditBegin.calculatedOrder) {
        return {
          success: false,
          errors: begin.orderEditBegin.userErrors.map((e) => e.message),
        };
      }
      const calc = begin.orderEditBegin.calculatedOrder;
      let finalTotal: string | undefined;

      for (const change of input.changes) {
        const numericId = change.removeLineItemId.replace(/^gid:\/\/shopify\/\w+\//, '');
        const calcLine = calc.lineItems.nodes.find((li) => li.id.endsWith(`/${numericId}`));
        if (!calcLine) {
          return { success: false, errors: [`Line item ${change.removeLineItemId} not found in the calculated order`] };
        }

        // Remove the old line.
        const rem = await this.graphql<{
          orderEditSetQuantity: { userErrors: { message: string }[] };
        }>(
          `mutation($id: ID!, $lineItemId: ID!, $quantity: Int!) {
            orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
              userErrors { message } } }`,
          { id: calc.id, lineItemId: calcLine.id, quantity: 0 }
        );
        if (rem.orderEditSetQuantity.userErrors.length > 0) {
          return { success: false, errors: rem.orderEditSetQuantity.userErrors.map((e) => e.message) };
        }

        // Add the new variant (duplicates allowed - see editOrder).
        const add = await this.graphql<{
          orderEditAddVariant: {
            calculatedLineItem: { id: string } | null;
            calculatedOrder: { id: string; totalPriceSet: { shopMoney: { amount: string } } } | null;
            userErrors: { message: string }[];
          };
        }>(
          `mutation($id: ID!, $variantId: ID!, $quantity: Int!) {
            orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, allowDuplicates: true) {
              calculatedLineItem { id }
              ${TOTALS}
              userErrors { message } } }`,
          { id: calc.id, variantId: change.addVariantId, quantity: change.quantity }
        );
        if (add.orderEditAddVariant.userErrors.length > 0) {
          return { success: false, errors: add.orderEditAddVariant.userErrors.map((e) => e.message) };
        }
        finalTotal = add.orderEditAddVariant.calculatedOrder?.totalPriceSet.shopMoney.amount;

        // Apply the absorb discount to the added line, if any.
        if (change.discount && parseFloat(change.discount) > 0.001 && add.orderEditAddVariant.calculatedLineItem) {
          const disc = await this.graphql<{
            orderEditAddLineItemDiscount: {
              calculatedOrder: { totalPriceSet: { shopMoney: { amount: string } } } | null;
              userErrors: { message: string }[];
            };
          }>(
            `mutation($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
              orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
                ${TOTALS}
                userErrors { message } } }`,
            {
              id: calc.id,
              lineItemId: add.orderEditAddVariant.calculatedLineItem.id,
              discount: {
                fixedValue: { amount: change.discount, currencyCode: input.currencyCode || 'USD' },
                description: 'Keeps your original pricing',
              },
            }
          );
          if (disc.orderEditAddLineItemDiscount.userErrors.length > 0) {
            return {
              success: false,
              errors: disc.orderEditAddLineItemDiscount.userErrors.map((e) => e.message),
            };
          }
          finalTotal = disc.orderEditAddLineItemDiscount.calculatedOrder?.totalPriceSet.shopMoney.amount;
        }
      }

      if (!finalTotal) {
        return { success: false, errors: ['Calculated total unavailable'] };
      }
      // Deliberately NOT committed - the session expires with no side effects.
      return { success: true, newTotalPrice: finalTotal };
    } catch (err) {
      return {
        success: false,
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

        // Find calculated line item IDs for the items we want to remove.
        // Match by the EXACT numeric id tail (CalculatedLineItem gids reuse
        // the LineItem's numeric id): a substring test could zero the WRONG
        // line ("1234" matches ".../51234"), and a silent miss would commit
        // an edit that adds the new item without removing the old one - the
        // customer's order then shows both shirts. Fail closed instead.
        for (const lineItemId of input.removeLineItemIds) {
          const numericId = lineItemId.replace(/^gid:\/\/shopify\/\w+\//, '');
          const calcLineItem = calculatedOrder.lineItems.nodes.find((li) =>
            li.id.endsWith(`/${numericId}`)
          );

          if (!calcLineItem) {
            return {
              success: false,
              errors: [
                `Line item ${lineItemId} was not found in the order edit - the edit was not committed.`,
              ],
            };
          }

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
          // Exact numeric-tail match; a silent miss must fail the edit (see
          // the remove loop above).
          const numericId = update.lineItemId.replace(/^gid:\/\/shopify\/\w+\//, '');
          const calcLineItem = calculatedOrder.lineItems.nodes.find((li) =>
            li.id.endsWith(`/${numericId}`)
          );

          if (!calcLineItem) {
            return {
              success: false,
              errors: [
                `Line item ${update.lineItemId} was not found in the order edit - the edit was not committed.`,
              ],
            };
          }

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

      // Step 4: Add new items
      if (input.addItems && input.addItems.length > 0) {
        // allowDuplicates: true is REQUIRED for size exchanges. When the new
        // size's variant is already a line on the order (e.g. one item is kept as
        // Terracotta/L and another is being changed TO Terracotta/L), the default
        // (false) rejects the add with "... was not added because it's already on
        // the order" and the whole Shopify edit fails. true adds it as its own
        // line so the exchange goes through.
        const ORDER_EDIT_ADD_VARIANT = `
          mutation orderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!, $allowDuplicates: Boolean) {
            orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, allowDuplicates: $allowDuplicates) {
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
            allowDuplicates: true,
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
   * Replacement orders with the id and tags needed to backfill reason tags.
   * Separate from getReplacementOrders because that one is shaped for the
   * insights aggregation and carries no order id.
   */
  async getReplacementOrdersForBackfill(
    sinceISO: string
  ): Promise<
    { id: string; name: string; createdAt: string; email: string | null; tags: string[] }[]
  > {
    const query = `
      query ReplacementOrdersForBackfill($q: String!, $after: String) {
        orders(first: 100, query: $q, after: $after, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          edges { node { id name createdAt email tags } }
        }
      }
    `;

    const out: {
      id: string;
      name: string;
      createdAt: string;
      email: string | null;
      tags: string[];
    }[] = [];
    let after: string | null = null;

    try {
      for (let page = 0; page < 50; page++) {
        const data: {
          orders: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            edges: {
              node: {
                id: string;
                name: string;
                createdAt: string;
                email: string | null;
                tags: string[];
              };
            }[];
          };
        } = await this.graphql(query, {
          q: `tag:Replacement created_at:>=${sinceISO}`,
          after,
        });

        for (const edge of data.orders.edges) {
          out.push({ ...edge.node, tags: edge.node.tags || [] });
        }
        if (!data.orders.pageInfo.hasNextPage) break;
        after = data.orders.pageInfo.endCursor;
      }
    } catch (err) {
      console.error('Error fetching replacement orders for backfill:', err);
    }

    return out;
  }

  /**
   * Add tags to an order. Deliberately `tagsAdd` and not `orderUpdate`: an
   * orderUpdate carrying a partial tag list replaces the whole set, which
   * would wipe every tag not named in the call.
   */
  async addOrderTags(
    orderId: string,
    tags: string[]
  ): Promise<{ success: boolean; error?: string }> {
    const mutation = `
      mutation AddOrderTags($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors { field message }
        }
      }
    `;

    try {
      const data: { tagsAdd: { userErrors: { field: string[]; message: string }[] } } =
        await this.graphql(mutation, { id: orderId, tags });
      const errors = data.tagsAdd?.userErrors || [];
      if (errors.length > 0) {
        return { success: false, error: errors.map((e) => e.message).join('; ') };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Units sold per product title over a date range, via ShopifyQL.
   *
   * The alternative - paginating every order in the range - does not scale:
   * the store runs 5,000-8,500 orders a month, so the old line-item walk was
   * silently truncating at its 4,000-order cap and understating sales (which
   * inflated every replacement rate). This is one 3-point query instead of
   * ~90 paginated ones.
   *
   * Two known properties of `net_items_sold`: it is net of returns, and it
   * counts the items on replacement orders too. The caller subtracts the
   * replacement units it has already tallied, which it knows exactly.
   */
  async getUnitsSoldByProduct(
    sinceISO: string,
    untilISO: string
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const query = `
      query UnitsSold($q: String!) {
        shopifyqlQuery(query: $q) {
          parseErrors
          tableData { rows }
        }
      }
    `;

    try {
      const data: {
        shopifyqlQuery: {
          parseErrors: string[] | null;
          tableData: { rows: { product_title: string; net_items_sold: string }[] } | null;
        } | null;
      } = await this.graphql(query, {
        q:
          `FROM sales SHOW net_items_sold GROUP BY product_title ` +
          `SINCE ${sinceISO} UNTIL ${untilISO} ORDER BY net_items_sold DESC LIMIT 1000`,
      });

      const errors = data.shopifyqlQuery?.parseErrors;
      if (errors && errors.length > 0) {
        console.error('ShopifyQL units-sold query rejected:', errors);
        return out;
      }

      for (const row of data.shopifyqlQuery?.tableData?.rows || []) {
        const units = Number(row.net_items_sold);
        if (row.product_title && Number.isFinite(units)) {
          out.set(row.product_title, units);
        }
      }
    } catch (err) {
      console.error('Error fetching units sold by product:', err);
    }

    return out;
  }

  /**
   * Line items of specific orders, looked up by order name/number.
   * Used to trace a replacement back to the order that actually went wrong,
   * so the failure is charged to the garment the customer complained about
   * rather than the one we shipped as the fix. Names are batched into OR
   * queries (Shopify caps a search string, so 40 per call) instead of one
   * request per order.
   */
  async getOrderLineItemsByNames(
    names: string[]
  ): Promise<Map<string, { createdAt: string; lineItems: { title: string; quantity: number }[] }>> {
    const out = new Map<
      string,
      { createdAt: string; lineItems: { title: string; quantity: number }[] }
    >();
    const unique = [...new Set(names)].filter(Boolean);
    if (unique.length === 0) return out;

    const query = `
      query OrdersByName($q: String!) {
        orders(first: 100, query: $q) {
          edges {
            node {
              name
              createdAt
              lineItems(first: 15) {
                edges { node { title quantity } }
              }
            }
          }
        }
      }
    `;

    const BATCH = 40;
    // Backstop: a pathological window can't turn into hundreds of calls
    const MAX_BATCHES = 25;
    try {
      for (let i = 0, batch = 0; i < unique.length && batch < MAX_BATCHES; i += BATCH, batch++) {
        const chunk = unique.slice(i, i + BATCH);
        const data: {
          orders: {
            edges: {
              node: {
                name: string;
                createdAt: string;
                lineItems: { edges: { node: { title: string; quantity: number } }[] };
              };
            }[];
          };
        } = await this.graphql(query, {
          q: chunk.map((n) => `name:#${n}`).join(' OR '),
        });

        for (const edge of data.orders.edges) {
          out.set(edge.node.name.replace(/^#/, ''), {
            createdAt: edge.node.createdAt,
            lineItems: edge.node.lineItems.edges.map((e) => e.node),
          });
        }
      }
    } catch (err) {
      console.error('Error fetching original orders by name:', err);
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

  /**
   * The list price of every size, per product LINE (classic tee, Premium tee,
   * long sleeve, kids, ...). Support needs this because our prices step up
   * with size, and without the real numbers the AI has been guessing the
   * ladder and getting it wrong in front of customers.
   *
   * Shopify has no "line" concept, so the line is derived from the garment
   * tags we already put on every product. Products are sampled (not the whole
   * catalog) because variants are expensive to page through; the ladder is the
   * MOST COMMON size->price map within a line, and anything that disagrees is
   * counted so the reply can admit the exceptions exist.
   */
  async getPriceLadders(maxProducts = 300): Promise<
    {
      line: string;
      ladder: { size: string; price: string }[];
      products: number;
      exceptions: number;
    }[]
  > {
    type Node = {
      productType: string;
      tags: string[];
      variants: { nodes: { price: string; selectedOptions: { name: string; value: string }[] }[] };
    };

    const nodes: Node[] = [];
    let cursor: string | null = null;
    try {
      while (nodes.length < maxProducts) {
        const data: {
          products: { nodes: Node[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
        } = await this.graphql(
          `query PriceLadders($first: Int!, $after: String) {
            products(first: $first, after: $after, query: "status:active") {
              nodes {
                productType
                tags
                variants(first: 60) {
                  nodes { price selectedOptions { name value } }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { first: 25, after: cursor }
        );
        nodes.push(...data.products.nodes);
        if (!data.products.pageInfo.hasNextPage) break;
        cursor = data.products.pageInfo.endCursor;
      }
    } catch (err) {
      console.error('Error fetching Shopify price ladders:', err);
      if (nodes.length === 0) return [];
    }

    // First matching tag wins, so the more specific garment is checked first.
    const lineOf = (n: Node): string => {
      const t = new Set(n.tags.map((x) => x.toLowerCase()));
      if (t.has('cc6014')) return 'Premium Long Sleeve (Comfort Colors)';
      if (t.has('bc6405')) return 'V-Neck Tee';
      if (t.has('toddler')) return 'Toddler Tee';
      if (t.has('kids')) return 'Kids Tee';
      if (t.has('cc1717') || t.has('premium')) return 'Premium Tee (Comfort Colors)';
      if (t.has('64000')) return 'Classic Tee';
      return n.productType || 'Other';
    };

    const SIZE_ORDER = [
      '2T', '3T', '4T', '5T', '5/6T',
      'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL',
    ];
    const sizeRank = (v: string) => {
      const i = SIZE_ORDER.indexOf(v.toUpperCase());
      return i === -1 ? SIZE_ORDER.length : i;
    };

    // size -> price for one product, as a comparable signature
    const ladderOf = (n: Node): Map<string, string> => {
      const m = new Map<string, string>();
      for (const v of n.variants.nodes) {
        const size = v.selectedOptions.find((o) => o.name.toLowerCase() === 'size')?.value;
        if (size && !m.has(size)) m.set(size, v.price);
      }
      return m;
    };

    const byLine = new Map<string, Map<string, { count: number; ladder: Map<string, string> }>>();
    for (const n of nodes) {
      const ladder = ladderOf(n);
      if (ladder.size === 0) continue;
      const line = lineOf(n);
      const sig = [...ladder.entries()]
        .sort((a, b) => sizeRank(a[0]) - sizeRank(b[0]))
        .map(([s, p]) => `${s}:${p}`)
        .join('|');
      const bucket = byLine.get(line) ?? new Map();
      const hit = bucket.get(sig);
      if (hit) hit.count++;
      else bucket.set(sig, { count: 1, ladder });
      byLine.set(line, bucket);
    }

    const out: { line: string; ladder: { size: string; price: string }[]; products: number; exceptions: number }[] = [];
    for (const [line, bucket] of byLine) {
      const variants = [...bucket.values()].sort((a, b) => b.count - a.count);
      const total = variants.reduce((sum, v) => sum + v.count, 0);
      const winner = variants[0];
      out.push({
        line,
        ladder: [...winner.ladder.entries()]
          .sort((a, b) => sizeRank(a[0]) - sizeRank(b[0]))
          .map(([size, price]) => ({ size, price })),
        products: total,
        exceptions: total - winner.count,
      });
    }
    return out.sort((a, b) => b.products - a.products);
  }

  /**
   * Every ACTIVE product carrying the same design as `baseTitle` - the same
   * artwork on the other garments (Premium, Kids Tee, Toddler, V-Neck, Long
   * Sleeve, Hoodie), each with the sizes it actually offers.
   *
   * Shopify has no "design" grouping, so a shared title prefix is the only
   * link between them, and its title search is token-based: "Sorry Rocks*"
   * also returns "Sorry I'm Late - Rock Lover". The prefix is therefore
   * re-checked here - these titles and links go straight into a reply to a
   * customer, so a near-miss is worse than an empty list.
   */
  async getDesignVersions(
    baseTitle: string,
    limit = 25
  ): Promise<
    { title: string; handle: string; productType: string; sizes: string[] }[]
  > {
    const base = baseTitle.trim();
    if (base.length < 3) return [];
    try {
      const data = await this.graphql<{
        products: {
          edges: {
            node: {
              title: string;
              handle: string;
              productType: string;
              options: { name: string; optionValues: { name: string }[] }[];
            };
          }[];
        };
      }>(
        `query DesignVersions($query: String!, $first: Int!) {
          products(first: $first, query: $query) {
            edges {
              node {
                title
                handle
                productType
                options { name optionValues { name } }
              }
            }
          }
        }`,
        { query: `title:${base}* AND status:active`, first: limit }
      );

      const prefix = base.toLowerCase();
      return data.products.edges
        .map((e) => e.node)
        .filter((p) => p.title.toLowerCase().startsWith(prefix))
        .map((p) => ({
          title: p.title,
          handle: p.handle,
          productType: p.productType,
          sizes:
            p.options
              .find((o) => o.name.toLowerCase() === 'size')
              ?.optionValues.map((v) => v.name) ?? [],
        }));
    } catch (err) {
      console.error('Error fetching design versions:', err);
      return [];
    }
  }
}
