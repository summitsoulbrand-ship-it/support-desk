/**
 * Shopify Admin API GraphQL query + mutation strings, extracted from client.ts
 * so the client file holds logic, not ~900 lines of GraphQL DSL. Pure strings,
 * imported back by client.ts; call sites unchanged.
 */

/**
 * GraphQL query for finding customer by email
 */
export const CUSTOMER_BY_EMAIL_QUERY = `
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
export const CUSTOMER_ORDERS_QUERY = `
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
            currentTotalPriceSet {
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
            totalDiscountsSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            discountCodes
            totalRefundedSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            totalRefundedShippingSet {
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
                  currentQuantity
                  originalUnitPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  discountAllocations {
                    allocatedAmountSet {
                      shopMoney {
                        amount
                      }
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
export const ORDERS_BY_EMAIL_QUERY = `
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
          currentTotalPriceSet {
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
          totalDiscountsSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          discountCodes
          totalRefundedSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalRefundedShippingSet {
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
                  currentQuantity
                  originalUnitPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  discountAllocations {
                    allocatedAmountSet {
                      shopMoney {
                        amount
                      }
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
export const ORDER_BY_ID_QUERY = `
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
      totalDiscountsSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      discountCodes
      currentTotalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      currentSubtotalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      currentTotalTaxSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      totalReceivedSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      totalOutstandingSet {
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
      totalRefundedShippingSet {
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
            currentQuantity
            originalUnitPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            discountAllocations {
              allocatedAmountSet {
                shopMoney {
                  amount
                }
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
export const PRODUCT_VARIANTS_QUERY = `
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
export const ORDER_UPDATE_MUTATION = `
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
export const ORDER_CANCEL_MUTATION = `
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
export const ORDER_CREATE_MUTATION = `
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
export const PRODUCT_SEARCH_QUERY = `
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
export const CUSTOMER_SEARCH_QUERY = `
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
export const DRAFT_ORDER_CREATE_MUTATION = `
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
export const DRAFT_ORDER_COMPLETE_MUTATION = `
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
export const ORDER_MARK_AS_PAID_MUTATION = `
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
export const REFUND_CREATE_MUTATION = `
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
export const ORDER_FULFILLMENT_ORDERS_QUERY = `
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
 * GraphQL mutation to create a fulfillment with tracking info
 * (validated against Admin API 2025-07)
 */
export const FULFILLMENT_CREATE_MUTATION = `
  mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
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
 * Existing fulfillments on an order (already-shipped case) so we can update the
 * tracking on the live fulfillment rather than create a new one.
 */
export const ORDER_FULFILLMENTS_QUERY = `
  query OrderFulfillments($orderId: ID!) {
    order(id: $orderId) {
      id
      fulfillments {
        id
        status
        createdAt
        trackingInfo {
          number
        }
      }
    }
  }
`;

/**
 * Update the tracking number on an existing fulfillment (already shipped -
 * e.g. a lost order being reshipped). Notifies the customer of the new number.
 */
export const FULFILLMENT_TRACKING_UPDATE_MUTATION = `
  mutation FulfillmentTrackingInfoUpdate(
    $fulfillmentId: ID!
    $trackingInfoInput: FulfillmentTrackingInput!
    $notifyCustomer: Boolean
  ) {
    fulfillmentTrackingInfoUpdate(
      fulfillmentId: $fulfillmentId
      trackingInfoInput: $trackingInfoInput
      notifyCustomer: $notifyCustomer
    ) {
      fulfillment {
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
 * GraphQL mutation to release hold on a fulfillment order
 */
export const FULFILLMENT_ORDER_RELEASE_HOLD_MUTATION = `
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
export const ORDER_TRANSACTIONS_QUERY = `
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
      totalRefundedShippingSet {
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

