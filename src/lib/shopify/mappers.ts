/**
 * Pure Shopify GraphQL -> domain mappers, extracted from client.ts so they can
 * be unit-tested in isolation (no network, no client state). The client imports
 * these and the call sites are unchanged.
 */

import { ShopifyOrder } from './types';

export type OrderNode = {
  id: string;
  name: string;
  legacyResourceId: string;
  email?: string | null;
  createdAt: string;
  updatedAt: string;
  displayFinancialStatus: string;
  displayFulfillmentStatus: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  currentTotalPriceSet?: { shopMoney: { amount: string; currencyCode: string } };
  subtotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  totalShippingPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  totalTaxSet: { shopMoney: { amount: string; currencyCode: string } };
  totalDiscountsSet?: { shopMoney: { amount: string; currencyCode: string } };
  discountCodes?: string[];
  totalRefundedSet?: { shopMoney: { amount: string; currencyCode: string } };
  totalRefundedShippingSet?: { shopMoney: { amount: string; currencyCode: string } };
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
        currentQuantity?: number;
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

export type MailingAddressInput = {
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

export const normalizeMailingAddress = (
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

/**
 * Address input for an UPDATE (not a create). normalizeMailingAddress DROPS
 * empty fields, which is right for a create but wrong for an update: Shopify
 * only changes the fields you send, so a dropped field leaves the OLD value in
 * place. That is the "clear the apartment number and it stays in Shopify" bug.
 *
 * Here, a clearable optional field (address2 / company / phone) that the caller
 * passed as an explicit empty string is kept as "" so Shopify actually clears
 * it. Required fields (address1, city, zip, ...) are still normalized normally;
 * we never blank those out from a stray empty form value.
 */
const CLEARABLE_ON_UPDATE: (keyof MailingAddressInput)[] = ['address2', 'company', 'phone'];

export function mailingAddressForUpdate(
  address: Parameters<typeof normalizeMailingAddress>[0]
): MailingAddressInput | undefined {
  const base = normalizeMailingAddress(address);
  if (!address) return base;
  const out: MailingAddressInput = { ...(base || {}) };
  for (const field of CLEARABLE_ON_UPDATE) {
    const raw = (address as Record<string, unknown>)[field];
    if (typeof raw === 'string' && raw.trim() === '') {
      out[field] = '';
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function mapOrderNode(order: OrderNode): ShopifyOrder {
  return {
    id: order.id,
    legacyResourceId: order.legacyResourceId,
    name: order.name,
    orderNumber: parseInt(order.legacyResourceId, 10),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    financialStatus: order.displayFinancialStatus,
    fulfillmentStatus: order.displayFulfillmentStatus,
    // Prefer the current total (reflects order edits - removed lines, etc.)
    // over the original order total, so an edited order shows what it's worth now.
    totalPrice: (order.currentTotalPriceSet ?? order.totalPriceSet).shopMoney.amount,
    totalPriceCurrency: (order.currentTotalPriceSet ?? order.totalPriceSet).shopMoney
      .currencyCode,
    subtotalPrice: order.subtotalPriceSet.shopMoney.amount,
    totalShippingPrice: order.totalShippingPriceSet.shopMoney.amount,
    totalTax: order.totalTaxSet.shopMoney.amount,
    totalDiscounts: order.totalDiscountsSet?.shopMoney.amount,
    discountCodes: order.discountCodes,
    totalRefunded: order.totalRefundedSet?.shopMoney.amount,
    totalRefundedShipping: order.totalRefundedShippingSet?.shopMoney.amount,
    note: order.note,
    tags: order.tags,
    cancelledAt: order.cancelledAt,
    cancelReason: order.cancelReason,
    customerId: order.customer?.id || '',
    customerEmail: order.email || undefined,
    lineItems: order.lineItems.edges
      // currentQuantity reflects order edits: a line removed via an edit drops
      // to 0 while `quantity` keeps the original count. Hide fully-removed lines
      // so the order shows what it actually contains now, not the pre-edit set.
      .filter((li) => (li.node.currentQuantity ?? li.node.quantity) > 0)
      .map((li) => {
      const qty = li.node.currentQuantity ?? li.node.quantity;
      const originalUnitPrice = parseFloat(li.node.originalUnitPriceSet.shopMoney.amount);
      const totalDiscount = (li.node.discountAllocations || []).reduce(
        (sum, da) => sum + parseFloat(da.allocatedAmountSet.shopMoney.amount),
        0
      );
      const discountedUnitPrice = originalUnitPrice - (totalDiscount / qty);
      return {
        id: li.node.id,
        title: li.node.title,
        variantTitle: li.node.variantTitle,
        quantity: qty,
        originalUnitPrice: li.node.originalUnitPriceSet.shopMoney.amount,
        originalUnitPriceCurrency:
          li.node.originalUnitPriceSet.shopMoney.currencyCode,
        discountedUnitPrice: discountedUnitPrice.toFixed(2),
        sku: li.node.sku,
        productId: li.node.product?.id,
        variantId: li.node.variant?.id,
        imageUrl: li.node.image?.url || undefined,
        variantImageUrl: li.node.variant?.image?.url || undefined,
        selectedOptions: li.node.variant?.selectedOptions || undefined,
      };
    }),
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
