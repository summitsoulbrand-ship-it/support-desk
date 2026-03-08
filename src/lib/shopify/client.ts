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

const API_VERSION = '2025-07';

/**
 * GraphQL query for finding customer by email
 */
const CUSTOMER_BY_EMAIL_QUERY = `
  query CustomerByEmail($email: String!) {
    customers(first: 1, query: $email) {
      edges {
        node {
          id
          email
          firstName
          lastName
          displayName
          phone
          tags
          createdAt
          note
          numberOfOrders
          amountSpent {
            amount
            currencyCode
          }
          defaultAddress {
            address1
            address2
            city
            province
            provinceCode
            country
            countryCodeV2
            zip
            phone
          }
        }
      }
    }
  }
`;

/**
 * GraphQL query for customer orders
 */
const CUSTOMER_ORDERS_QUERY = `
  query CustomerOrders($customerId: ID!, $first: Int!) {
    customer(id: $customerId) {
      orders(first: $first, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            legacyResourceId
            createdAt
            updatedAt
            displayFinancialStatus
            displayFulfillmentStatus
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            subtotalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            totalShippingPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            totalTaxSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            note
            tags
            cancelledAt
            cancelReason
            lineItems(first: 50) {
              edges {
                node {
                  id
                  title
                  variantTitle
                  quantity
                  originalUnitPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  sku
                  image {
                    url
                  }
                  product {
                    id
                  }
                  variant {
                    id
                    image {
                      url
                    }
                    selectedOptions {
                      name
                      value
                    }
                  }
                }
              }
            }
            fulfillments {
              id
              status
              trackingInfo {
                number
                url
                company
              }
              createdAt
              updatedAt
              fulfillmentLineItems(first: 50) {
                edges {
                  node {
                    id
                    quantity
                    lineItem {
                      id
                    }
                  }
                }
              }
            }
            shippingAddress {
              name
              firstName
              lastName
              company
              address1
              address2
              city
              province
              provinceCode
              country
              countryCodeV2
              zip
              phone
            }
            billingAddress {
              name
              firstName
              lastName
              company
              address1
              address2
              city
              province
              provinceCode
              country
              countryCodeV2
              zip
              phone
            }
            metafields(first: 10, keys: ["printify.order_id", "custom.printify_order"]) {
              edges {
                node {
                  key
                  namespace
                  value
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * GraphQL query for orders by email (guest checkouts)
 */
const ORDERS_BY_EMAIL_QUERY = `
  query OrdersByEmail($query: String!, $first: Int!) {
    orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          name
          legacyResourceId
          email
          createdAt
          updatedAt
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          subtotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalShippingPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalTaxSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          note
          tags
          cancelledAt
          cancelReason
          customer {
            id
          }
          lineItems(first: 50) {
            edges {
                node {
                  id
                  title
                  variantTitle
                  quantity
                  originalUnitPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  sku
                  image {
                    url
                  }
                  product {
                    id
                  }
                  variant {
                    id
                    image {
                      url
                    }
                    selectedOptions {
                      name
                      value
                    }
                  }
                }
              }
            }
          fulfillments {
            id
            status
            trackingInfo {
              number
              url
              company
            }
            createdAt
            updatedAt
            fulfillmentLineItems(first: 50) {
              edges {
                node {
                  id
                  quantity
                  lineItem {
                    id
                  }
                }
              }
            }
          }
          shippingAddress {
            name
            firstName
            lastName
            company
            address1
            address2
            city
            province
            provinceCode
            country
            countryCodeV2
            zip
            phone
          }
          billingAddress {
            name
            firstName
            lastName
            company
            address1
            address2
            city
            province
            provinceCode
            country
            countryCodeV2
            zip
            phone
          }
          metafields(first: 10, keys: ["printify.order_id", "custom.printify_order"]) {
            edges {
              node {
                key
                namespace
                value
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * GraphQL query for a single order by ID
 */
const ORDER_BY_ID_QUERY = `
  query OrderById($id: ID!) {
    order(id: $id) {
      id
      name
      legacyResourceId
      email
      createdAt
      updatedAt
      displayFinancialStatus
      displayFulfillmentStatus
      totalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      subtotalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      totalShippingPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      totalTaxSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      note
      tags
      cancelledAt
      cancelReason
      customer {
        id
      }
      lineItems(first: 50) {
        edges {
          node {
            id
            title
            variantTitle
            quantity
            originalUnitPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            sku
            product {
              id
            }
            variant {
              id
              image {
                url
              }
              selectedOptions {
                name
                value
              }
            }
          }
        }
      }
      fulfillments {
        id
        status
        trackingInfo {
          number
          url
          company
        }
        createdAt
        updatedAt
        fulfillmentLineItems(first: 50) {
          edges {
            node {
              id
              quantity
              lineItem {
                id
              }
            }
          }
        }
      }
      shippingAddress {
        name
        firstName
        lastName
        company
        address1
        address2
        city
        province
        provinceCode
        country
        countryCodeV2
        zip
        phone
      }
      billingAddress {
        name
        firstName
        lastName
        company
        address1
        address2
        city
        province
        provinceCode
        country
        countryCodeV2
        zip
        phone
      }
      metafields(first: 10, keys: ["printify.order_id", "custom.printify_order"]) {
        edges {
          node {
            key
            namespace
            value
          }
        }
      }
    }
  }
`;

/**
 * GraphQL query for product variants
 */
const PRODUCT_VARIANTS_QUERY = `
  query ProductVariants($id: ID!, $first: Int!, $after: String) {
    product(id: $id) {
      id
      title
      variants(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
            price
            sku
            availableForSale
            image {
              url
            }
            selectedOptions {
              name
              value
            }
          }
        }
      }
    }
  }
`;

/**
 * GraphQL mutation for updating an order
 */
const ORDER_UPDATE_MUTATION = `
  mutation OrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * GraphQL mutation for canceling an order
 */
const ORDER_CANCEL_MUTATION = `
  mutation OrderCancel(
    $orderId: ID!
    $notifyCustomer: Boolean
    $refundMethod: OrderCancelRefundMethodInput
    $restock: Boolean!
    $reason: OrderCancelReason!
    $staffNote: String
  ) {
    orderCancel(
      orderId: $orderId
      notifyCustomer: $notifyCustomer
      refundMethod: $refundMethod
      restock: $restock
      reason: $reason
      staffNote: $staffNote
    ) {
      job {
        id
        done
      }
      orderCancelUserErrors {
        field
        message
        code
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * GraphQL mutation for creating an order
 */
const ORDER_CREATE_MUTATION = `
  mutation OrderCreate($order: OrderCreateOrderInput!) {
    orderCreate(order: $order) {
      order {
        id
        name
        legacyResourceId
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * GraphQL query for searching products
 */
const PRODUCT_SEARCH_QUERY = `
  query ProductSearch($query: String!, $first: Int!) {
    products(first: $first, query: $query) {
      edges {
        node {
          id
          title
          handle
          status
          featuredImage {
            url
          }
          variants(first: 20) {
            edges {
              node {
                id
                title
                price
                sku
                availableForSale
                image {
                  url
                }
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * GraphQL query for searching customers
 */
const CUSTOMER_SEARCH_QUERY = `
  query CustomerSearch($query: String!, $first: Int!) {
    customers(first: $first, query: $query) {
      edges {
        node {
          id
          email
          displayName
          phone
          tags
          createdAt
          note
          numberOfOrders
          amountSpent {
            amount
            currencyCode
          }
          defaultAddress {
            address1
            address2
            city
            province
            provinceCode
            country
            countryCodeV2
            zip
            phone
          }
        }
      }
    }
  }
`;

/**
 * GraphQL mutation for creating a draft order
 */
const DRAFT_ORDER_CREATE_MUTATION = `
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        legacyResourceId
        invoiceUrl
        status
        totalPrice
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * GraphQL mutation for completing a draft order
 */
const DRAFT_ORDER_COMPLETE_MUTATION = `
  mutation DraftOrderComplete($id: ID!, $paymentPending: Boolean) {
    draftOrderComplete(id: $id, paymentPending: $paymentPending) {
      draftOrder {
        id
        order {
          id
          name
          legacyResourceId
          displayFinancialStatus
          canMarkAsPaid
          totalOutstandingSet {
            shopMoney {
              amount
              currencyCode
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

/**
 * GraphQL mutation for marking an order as paid
 */
const ORDER_MARK_AS_PAID_MUTATION = `
  mutation OrderMarkAsPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      order {
        id
        displayFinancialStatus
        totalOutstandingSet {
          shopMoney {
            amount
            currencyCode
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

/**
 * GraphQL mutation for refunding an order
 */
const REFUND_CREATE_MUTATION = `
  mutation RefundCreate($input: RefundInput!) {
    refundCreate(input: $input) {
      refund {
        id
        totalRefundedSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        transactions(first: 10) {
          edges {
            node {
              amountSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
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

/**
 * GraphQL query to get fulfillment orders for an order
 */
const ORDER_FULFILLMENT_ORDERS_QUERY = `
  query OrderFulfillmentOrders($orderId: ID!) {
    order(id: $orderId) {
      id
      fulfillmentOrders(first: 10) {
        edges {
          node {
            id
            status
            requestStatus
          }
        }
      }
    }
  }
`;

/**
 * GraphQL mutation to release hold on a fulfillment order
 */
const FULFILLMENT_ORDER_RELEASE_HOLD_MUTATION = `
  mutation FulfillmentOrderReleaseHold($id: ID!) {
    fulfillmentOrderReleaseHold(id: $id) {
      fulfillmentOrder {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * GraphQL query to get order refund details
 */
const ORDER_TRANSACTIONS_QUERY = `
  query OrderTransactions($orderId: ID!) {
    order(id: $orderId) {
      id
      name
      totalReceivedSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      totalRefundedSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      transactions {
        id
        kind
        status
        amountSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        gateway
        parentTransaction {
          id
        }
      }
    }
  }
`;

type OrderNode = {
  id: string;
  name: string;
  legacyResourceId: string;
  email?: string | null;
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
  customer?: { id: string } | null;
  lineItems: {
    edges: {
      node: {
        id: string;
        title: string;
        variantTitle?: string;
        quantity: number;
        originalUnitPriceSet: { shopMoney: { amount: string; currencyCode: string } };
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
    countryCodeV2?: string;
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

type MailingAddressInput = {
  firstName?: string;
  lastName?: string;
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  provinceCode?: string;
  countryCode?: string;
  zip?: string;
  phone?: string;
  // Deprecated but still accepted by Shopify in some contexts.
  province?: string;
  country?: string;
};

const normalizeMailingAddress = (
  address?: {
    name?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province?: string | null;
    provinceCode?: string | null;
    country?: string | null;
    countryCode?: string | null;
    countryCodeV2?: string | null;
    zip?: string | null;
    phone?: string | null;
  } | null
): MailingAddressInput | undefined => {
  if (!address) return undefined;

  const safe = (value?: string | null) => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const output: MailingAddressInput = {};
  const firstName = safe(address.firstName);
  const lastName = safe(address.lastName);
  const name = safe(address.name);

  if (firstName) output.firstName = firstName;
  if (lastName) output.lastName = lastName;

  if (name && (!firstName || !lastName)) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (!firstName && parts[0]) {
      output.firstName = parts[0];
    }
    if (!lastName) {
      output.lastName =
        parts.length > 1 ? parts.slice(1).join(' ') : parts[0];
    }
  }

  const fields: Array<keyof MailingAddressInput> = [
    'company',
    'address1',
    'address2',
    'city',
    'provinceCode',
    'zip',
    'phone',
  ];

  fields.forEach((field) => {
    const value = safe(address[field] as string | null | undefined);
    if (value) {
      output[field] = value;
    }
  });

  const countryCode = safe(address.countryCode) || safe(address.countryCodeV2);
  if (countryCode) {
    output.countryCode = countryCode;
  } else {
    const fallbackCountry = safe(address.country);
    if (fallbackCountry) {
      output.country = fallbackCountry;
    }
  }

  if (!output.provinceCode) {
    const fallbackProvince = safe(address.province);
    if (fallbackProvince) {
      output.province = fallbackProvince;
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
};

function mapOrderNode(order: OrderNode): ShopifyOrder {
  return {
    id: order.id,
    legacyResourceId: order.legacyResourceId,
    name: order.name,
    orderNumber: parseInt(order.legacyResourceId, 10),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    financialStatus: order.displayFinancialStatus,
    fulfillmentStatus: order.displayFulfillmentStatus,
    totalPrice: order.totalPriceSet.shopMoney.amount,
    totalPriceCurrency: order.totalPriceSet.shopMoney.currencyCode,
    subtotalPrice: order.subtotalPriceSet.shopMoney.amount,
    totalShippingPrice: order.totalShippingPriceSet.shopMoney.amount,
    totalTax: order.totalTaxSet.shopMoney.amount,
    note: order.note,
    tags: order.tags,
    cancelledAt: order.cancelledAt,
    cancelReason: order.cancelReason,
    customerId: order.customer?.id || '',
    customerEmail: order.email || undefined,
    lineItems: order.lineItems.edges.map((li) => ({
      id: li.node.id,
      title: li.node.title,
      variantTitle: li.node.variantTitle,
      quantity: li.node.quantity,
      originalUnitPrice: li.node.originalUnitPriceSet.shopMoney.amount,
      originalUnitPriceCurrency:
        li.node.originalUnitPriceSet.shopMoney.currencyCode,
      sku: li.node.sku,
      productId: li.node.product?.id,
      variantId: li.node.variant?.id,
      imageUrl: li.node.image?.url || undefined,
      variantImageUrl: li.node.variant?.image?.url || undefined,
      selectedOptions: li.node.variant?.selectedOptions || undefined,
    })),
    fulfillments: order.fulfillments.map((f) => ({
      id: f.id,
      status: f.status,
      trackingNumber: f.trackingInfo[0]?.number,
      trackingUrl: f.trackingInfo[0]?.url,
      trackingCompany: f.trackingInfo[0]?.company,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      lineItems: f.fulfillmentLineItems.edges.map((fli) => ({
        id: fli.node.lineItem.id,
        quantity: fli.node.quantity,
      })),
    })),
    shippingAddress: order.shippingAddress
      ? {
          ...order.shippingAddress,
          countryCode: order.shippingAddress.countryCodeV2,
        }
      : undefined,
    billingAddress: order.billingAddress
      ? {
          ...order.billingAddress,
          countryCode: order.billingAddress.countryCodeV2,
        }
      : undefined,
    metafields: order.metafields.edges.map((m) => ({
      key: m.node.key,
      namespace: m.node.namespace,
      value: m.node.value,
    })),
  };
}

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
        { query: `email:${email}`, first: limit }
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

      const normalizedAddress = normalizeMailingAddress(shippingAddress);

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
    staffNote?: string
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
        notifyCustomer: true,
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

      // Only add transaction if there's a line item amount to refund
      if (refundAmount > 0) {
        refundInput.transactions = [
          {
            orderId,
            parentId: refundableTransaction.id,
            amount: refundAmount.toFixed(2),
            kind: 'REFUND',
            gateway: refundableTransaction.gateway,
          },
        ];
      }

      // Add shipping refund if requested
      if (options?.refundShipping) {
        if (options?.shippingAmount) {
          refundInput.shipping = { amount: options.shippingAmount };
        } else {
          refundInput.shipping = { fullRefund: true };
        }
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
      const responseAmount = data.refundCreate.refund?.totalRefundedSet?.shopMoney?.amount;
      const transactionAmount = data.refundCreate.refund?.transactions?.edges?.[0]?.node?.amountSet?.shopMoney?.amount;

      // For shipping-only refunds, refundAmount is 0 - use response amount or shipping amount
      let actualRefundedAmount: string;
      if (refundAmount > 0) {
        // Line item refund - use transaction amount, response amount, or fallback
        actualRefundedAmount =
          (transactionAmount && parseFloat(transactionAmount) > 0) ? transactionAmount :
          (responseAmount && parseFloat(responseAmount) > 0) ? responseAmount :
          refundAmount.toFixed(2);
      } else if (options?.refundShipping) {
        // Shipping-only refund
        actualRefundedAmount = options.shippingAmount ||
          (responseAmount && parseFloat(responseAmount) > 0 ? responseAmount : 'shipping');
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
}
