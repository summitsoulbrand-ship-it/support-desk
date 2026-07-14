/**
 * Pure helpers for the customer sidebar (no React, no hooks, no JSX), extracted
 * from customer-sidebar.tsx so they can be unit-tested in isolation. Behavior is
 * unchanged; the component imports these and call sites are the same.
 */

import { canonicalSize } from '@/lib/ai/order-match';
import type {
  ShopifyAddress,
  ShopifyOrder,
  PrintifyOrderMatch,
  ProductVariantsResponse,
  VariantWithOptions,
} from './types';

// Show a customer-typed size as its canonical label ("1X" -> "XL", "2x" ->
// "2XL"); leave unrecognized values as-is. Keeps the UI consistent with the
// variant we actually match to.
export function displaySize(s?: string): string | undefined {
  if (!s) return s;
  const c = canonicalSize(s);
  return c ? c.toUpperCase() : s;
}

export function isPrintifyInProduction(order?: PrintifyOrderMatch): boolean {
  if (!order) return false;
  const statuses = order.order.line_items.map((li) => li.status);
  const shippedStatuses = new Set([
    'shipping',
    'fulfilled',
    'delivered',
    'partially-fulfilled',
  ]);
  return (
    statuses.some((status) => shippedStatuses.has(status)) ||
    shippedStatuses.has(order.order.status)
  );
}

export function getColorOption(
  options?: { name: string; value: string }[]
): string | null {
  if (!options) return null;
  const color = options.find((opt) =>
    opt.name.toLowerCase().includes('color')
  );
  return color?.value || null;
}

export function colorToHex(color: string): string | null {
  const normalized = color.toLowerCase().trim();
  if (normalized.startsWith('#')) {
    return normalized;
  }

  const map: Record<string, string> = {
    black: '#111827',
    white: '#f9fafb',
    gray: '#4b5563',
    grey: '#4b5563',
    red: '#dc2626',
    blue: '#2563eb',
    green: '#16a34a',
    yellow: '#f59e0b',
    orange: '#f97316',
    purple: '#7c3aed',
    pink: '#ec4899',
    brown: '#92400e',
    navy: '#1e3a8a',
    beige: '#f5f5dc',
    cream: '#fef3c7',
  };

  return map[normalized] || null;
}

// Prefer real carrier movement over Shopify's "fulfilled" flag, which flips
// the moment a label is created. A created label is NOT "shipped".
export function getDisplayTrackingStatus(
  order: ShopifyOrder,
  carrierStatus?: string,
  // Printify's delivered_at is authoritative and often lands before the carrier
  // feed flips - trust it so the badge doesn't stay stuck on "Shipped".
  deliveredByPrintify?: boolean
): string {
  if (deliveredByPrintify) return 'Delivered';
  switch (carrierStatus) {
    case 'delivered':
      return 'Delivered';
    case 'out_for_delivery':
      return 'Out for delivery';
    case 'in_transit':
      return 'In transit';
    case 'info_received':
      return 'Label created';
    case 'pending':
      return 'Processing';
  }
  return getTrackingStatus(order);
}

export function trackingBadgeVariant(status: string): 'success' | 'info' | 'warning' {
  if (status === 'Delivered') return 'success';
  if (status === 'In transit' || status === 'Out for delivery' || status === 'Shipped')
    return 'info';
  return 'warning';
}

export function getTrackingStatus(order: ShopifyOrder): string {
  // Check if any fulfillment shows as delivered
  const hasDelivered = order.fulfillments.some(
    (f) => f.status?.toLowerCase() === 'delivered'
  );
  if (hasDelivered) {
    return 'Delivered';
  }

  // Check if order is fulfilled (shipped) with tracking
  if (order.fulfillmentStatus?.toLowerCase() === 'fulfilled') {
    if (order.fulfillments.some((f) => f.trackingNumber)) {
      return 'Shipped';
    }
    return 'Fulfilled';
  }

  // Partially fulfilled
  if (order.fulfillmentStatus?.toLowerCase() === 'partial') {
    return 'Partially shipped';
  }

  // Has tracking but not fully fulfilled
  if (order.fulfillments.some((f) => f.trackingNumber)) {
    return 'In transit';
  }

  return 'Processing';
}

export function getMatchScore(value: string, query: string): number {
  const hay = value.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return 0;
  if (hay === needle) return 100;
  if (hay.startsWith(needle)) return 80;
  if (hay.includes(needle)) return 50;
  return 0;
}

export function getSearchOptionName(
  variants: VariantWithOptions[],
  keyword: string
): string | null {
  for (const variant of variants) {
    for (const option of variant.selectedOptions || []) {
      if (option.name.toLowerCase().includes(keyword)) {
        return option.name;
      }
    }
  }
  return null;
}

export function getSearchOptionValues(
  variants: VariantWithOptions[],
  optionName: string | null
): string[] {
  if (!optionName) return [];
  const values = new Set<string>();
  variants.forEach((variant) => {
    variant.selectedOptions?.forEach((opt) => {
      if (opt.name === optionName) {
        values.add(opt.value);
      }
    });
  });
  return Array.from(values);
}

export function findSearchVariant<T extends VariantWithOptions>(
  variants: T[],
  colorName: string | null,
  sizeName: string | null,
  color?: string,
  size?: string
): T | undefined {
  if (!colorName && !sizeName) {
    return variants[0];
  }
  const normalizedColor = color?.trim().toLowerCase();
  const normalizedSize = size?.trim().toLowerCase();
  return variants.find((variant) => {
    const selected = variant.selectedOptions || [];
    const colorMatch = colorName
      ? selected.some(
          (opt) =>
            opt.name === colorName &&
            opt.value.trim().toLowerCase() === normalizedColor
        )
      : true;
    const sizeMatch = sizeName
      ? selected.some(
          (opt) =>
            opt.name === sizeName &&
            opt.value.trim().toLowerCase() === normalizedSize
        )
      : true;
    return colorMatch && sizeMatch;
  });
}

export function findSearchVariantByValues<T extends VariantWithOptions>(
  variants: T[],
  color?: string,
  size?: string
): T | undefined {
  const normalizedColor = color?.trim().toLowerCase();
  const normalizedSize = size?.trim().toLowerCase();
  if (!normalizedColor && !normalizedSize) {
    return variants[0];
  }
  return variants.find((variant) => {
    const selected = variant.selectedOptions || [];
    const colorMatch = normalizedColor
      ? selected.some(
          (opt) => opt.value.trim().toLowerCase() === normalizedColor
        )
      : true;
    const sizeMatch = normalizedSize
      ? selected.some((opt) => opt.value.trim().toLowerCase() === normalizedSize)
      : true;
    return colorMatch && sizeMatch;
  });
}

export function findSearchVariantByTitle<T extends VariantWithOptions>(
  variants: T[],
  color?: string,
  size?: string
): T | undefined {
  const normalizedColor = color?.trim().toLowerCase();
  const normalizedSize = size?.trim().toLowerCase();
  if (!normalizedColor && !normalizedSize) {
    return undefined;
  }
  return variants.find((variant) => {
    const title = variant.title?.toLowerCase() || '';
    const colorMatch = normalizedColor ? title.includes(normalizedColor) : true;
    const sizeMatch = normalizedSize ? title.includes(normalizedSize) : true;
    return colorMatch && sizeMatch;
  });
}

export function getOptionName(
  variants: ProductVariantsResponse['variants'],
  keyword: string
): string | null {
  for (const variant of variants) {
    for (const option of variant.selectedOptions || []) {
      if (option.name.toLowerCase().includes(keyword)) {
        return option.name;
      }
    }
  }
  return null;
}

export function getVariantOptionValue(
  variant: VariantWithOptions | undefined,
  optionName: string | null
): string | null {
  if (!variant || !optionName) return null;
  const match = (variant.selectedOptions || []).find(
    (opt) => opt.name === optionName
  );
  return match?.value || null;
}

export function getOptionValues(
  variants: ProductVariantsResponse['variants'],
  optionName: string | null
): string[] {
  if (!optionName) return [];
  const values = new Set<string>();
  variants.forEach((variant) => {
    variant.selectedOptions?.forEach((opt) => {
      if (opt.name === optionName) {
        values.add(opt.value);
      }
    });
  });
  return Array.from(values);
}

export function getAddressDisplayName(address?: ShopifyAddress): string | null {
  if (!address) return null;
  if (address.name) return address.name;
  const parts = [address.firstName, address.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

export function formatUsAddress(address?: ShopifyAddress): string[] {
  if (!address) return [];
  const name =
    address.name ||
    [address.firstName, address.lastName].filter(Boolean).join(' ');
  const city = address.city || '';
  const state = address.provinceCode || address.province || '';
  const zip = address.zip || '';
  const cityLine = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean);
  const lines = [
    name,
    address.company,
    address.address1,
    address.address2,
    cityLine.join(', '),
    address.country || address.countryCode,
    address.phone,
  ].filter(Boolean) as string[];
  return lines;
}
