'use client';

/**
 * Customer sidebar - displays Shopify customer info and orders with Printify mapping
 */

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn, formatDate, formatCurrency, getStatusColor } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AddressAutocomplete, SelectedAddress } from '@/components/ui/address-autocomplete';
import {
  User,
  ShoppingBag,
  Package,
  Truck,
  ExternalLink,
  RefreshCw,
  AlertCircle,
  Tag,
  DollarSign,
  Pencil,
  Save,
  X,
  ShieldCheck,
  ShieldX,
  Repeat,
  ChevronLeft,
  ChevronRight,
  Search,
  RotateCcw,
  ChevronUp,
  ChevronDown,
  Minus,
  Plus,
  Trash2,
  Copy,
  Check,
  MessageSquare,
  Star,
} from 'lucide-react';

interface CustomerSidebarProps {
  threadId: string;
}

interface ShopifyAddress {
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

interface ShopifyCustomer {
  displayName: string;
  email: string;
  totalSpent: string;
  totalSpentCurrency: string;
  numberOfOrders: number;
  tags: string[];
  note?: string;
  id?: string;
  defaultAddress?: {
    city?: string;
    provinceCode?: string;
    country?: string;
  };
}

interface ShopifyOrder {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  financialStatus: string;
  fulfillmentStatus: string | null;
  totalPrice: string;
  totalPriceCurrency: string;
  subtotalPrice?: string;
  totalShippingPrice?: string;
  totalTax?: string;
  totalRefunded?: string;
  customerEmail?: string;
  lineItems: {
    id: string;
    title: string;
    variantTitle?: string;
    quantity: number;
    productId?: string;
    variantId?: string;
    imageUrl?: string;
    variantImageUrl?: string;
    selectedOptions?: { name: string; value: string }[];
    originalUnitPrice?: string;
    sku?: string;
  }[];
  fulfillments: {
    id: string;
    status: string;
    trackingNumber?: string;
    trackingUrl?: string;
    trackingCompany?: string;
  }[];
  shippingAddress?: ShopifyAddress;
  billingAddress?: ShopifyAddress;
  note?: string;
  tags: string[];
  cancelledAt?: string;
}

interface PrintifyAddress {
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

interface PrintifyOrderMatch {
  shopifyOrderId: string;
  order: {
    id: string;
    app_order_id?: string;
    status: string;
    created_at?: string;
    address_to: PrintifyAddress;
    line_items: {
      status: string;
      sent_to_production_at?: string;
      metadata?: {
        title?: string;
      };
    }[];
    shipments: {
      carrier: string;
      number: string;
      url?: string;
      shipped_at?: string;
      delivered_at?: string;
    }[];
    printify_connect?: {
      url?: string;
    };
  };
  productionStatus: string;
  matchMethod: string;
  matchConfidence: number;
}

interface ProductVariantsResponse {
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

interface ShippingRateOption {
  id: string;
  title: string;
  price: string;
  currencyCode?: string;
  zoneName?: string;
}

interface SearchProduct {
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
    imageUrl?: string;
    selectedOptions?: { name: string; value: string }[];
  }[];
}

interface ReplacementLineItem {
  id: string;
  productId?: string;
  title: string;
  variantId: string;
  variantTitle: string;
  quantity: number;
  imageUrl?: string;
  selectedOptions?: { name: string; value: string }[];
  price?: string;
  sku?: string;
  originalLineItemId?: string;
  originalVariantId?: string; // Track original variant to detect size/variant changes
  originalPrice?: string; // Track original price to calculate difference for discounts
  discount?: string; // Discount amount to apply (fixed amount)
}

interface ContextData {
  thread?: { customerEmail: string; customerName: string | null };
  customer?: ShopifyCustomer;
  orders?: ShopifyOrder[];
  printifyOrders?: PrintifyOrderMatch[];
  printifySyncNeeded?: boolean;
  storeDomain?: string;
  printifyShopId?: string;
  customerMatchMethod?: 'email' | 'name' | 'order_name';
  cached?: boolean;
}

const emptyShopifyAddress: ShopifyAddress = {
  name: '',
  firstName: '',
  lastName: '',
  company: '',
  address1: '',
  address2: '',
  city: '',
  province: '',
  provinceCode: '',
  country: '',
  countryCode: '',
  zip: '',
  phone: '',
};

const defaultReplacementTags = [
  'too small',
  'too big',
  'wrong size ordered',
  'wrong shirt ordered',
  'wrong address',
  'defect',
];

function isPrintifyInProduction(order?: PrintifyOrderMatch): boolean {
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

function getColorOption(
  options?: { name: string; value: string }[]
): string | null {
  if (!options) return null;
  const color = options.find((opt) =>
    opt.name.toLowerCase().includes('color')
  );
  return color?.value || null;
}

function colorToHex(color: string): string | null {
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

function getTrackingStatus(order: ShopifyOrder): string {
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

function getMatchScore(value: string, query: string): number {
  const hay = value.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return 0;
  if (hay === needle) return 100;
  if (hay.startsWith(needle)) return 80;
  if (hay.includes(needle)) return 50;
  return 0;
}

type VariantWithOptions = {
  selectedOptions?: { name: string; value: string }[];
  title?: string;
};

function getSearchOptionName(
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

function getSearchOptionValues(
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

function findSearchVariant<T extends VariantWithOptions>(
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

function findSearchVariantByValues<T extends VariantWithOptions>(
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

function findSearchVariantByTitle<T extends VariantWithOptions>(
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

function getOptionName(
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

function getVariantOptionValue(
  variant: VariantWithOptions | undefined,
  optionName: string | null
): string | null {
  if (!variant || !optionName) return null;
  const match = (variant.selectedOptions || []).find(
    (opt) => opt.name === optionName
  );
  return match?.value || null;
}

function getOptionValues(
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

function getAddressDisplayName(address?: ShopifyAddress): string | null {
  if (!address) return null;
  if (address.name) return address.name;
  const parts = [address.firstName, address.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

function formatUsAddress(address?: ShopifyAddress): string[] {
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

export function CustomerSidebar({ threadId }: CustomerSidebarProps) {
  const [refreshToken, setRefreshToken] = useState(0);
  const { data, isLoading, error, refetch, isFetching } = useQuery<ContextData>({
    queryKey: ['context', threadId, refreshToken],
    queryFn: async () => {
      const forceFresh = refreshToken > 0;
      const res = await fetch(
        `/api/threads/${threadId}/context${forceFresh ? '?fresh=1' : ''}`
      );
      if (!res.ok) throw new Error('Failed to fetch context');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const [editingAddress, setEditingAddress] = useState<Record<string, boolean>>(
    {}
  );
  const [addressEdits, setAddressEdits] = useState<
    Record<string, ShopifyAddress>
  >({});
  const [savingAddressFor, setSavingAddressFor] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [printifyCancelLink, setPrintifyCancelLink] = useState<string | null>(
    null
  );

  const [currentOrderIndex, setCurrentOrderIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<'orders' | 'reviews'>('orders');

  // Fetch Judge.me reviews
  const { data: reviewsData, isLoading: reviewsLoading } = useQuery<{
    reviews: Array<{
      id: number;
      title: string;
      body: string;
      rating: number;
      reviewer: { name: string; email: string };
      product: { title: string; handle: string };
      createdAt: string;
      verifiedPurchase: boolean;
      replied: boolean;
      pictureUrls?: string[];
    }>;
    totalCount: number;
  }>({
    queryKey: ['reviews', threadId],
    queryFn: async () => {
      const res = await fetch(`/api/threads/${threadId}/reviews`);
      if (!res.ok) return { reviews: [], totalCount: 0 };
      return res.json();
    },
    enabled: activeTab === 'reviews',
    staleTime: 5 * 60 * 1000,
  });

  // Reset order index when thread changes
  useEffect(() => {
    setCurrentOrderIndex(0);
  }, [threadId]);

  useEffect(() => {
    setReplacementModalOrderId(null);
    setReplacementProductSearch('');
    setReplacementSearchResults([]);
    setReplacementSearchSelection({});
    replacementSearchSelectionRef.current = {};
    setReplacementItems({});
    setReplacementNotes({});
    setReplacementTags({});
    setReplacementReasons({});
    setReplacementDiscountType({});
    setReplacementDiscountValue({});
    setReplacementTaxExempt({});
    setReplacementCustomerSearch('');
    setReplacementCustomerResults([]);
    setReplacementSelectedCustomer({});
    setShowCustomerSearch({});
    setEditingShipping({});
    setEditingBilling({});
    setReplacementShippingAddress({});
    setReplacementBillingAddress({});
    setReplacementShippingRates({});
    setReplacementShippingRateSelection({});
    setReplacementShippingRatesLoading({});
    setPrintifyAddressConfirmed({});
    setPrintifyAddressNeedsUpdate({});
    setPrintifyWarningOrderId(null);
    setActionError(null);
    setActionNote(null);
  }, [threadId]);

  const [cancelingShopifyId, setCancelingShopifyId] = useState<string | null>(
    null
  );
  const [cancelingPrintifyId, setCancelingPrintifyId] = useState<string | null>(
    null
  );
  const [cancelModalOrderId, setCancelModalOrderId] = useState<string | null>(
    null
  );
  const [cancelReasonByOrder, setCancelReasonByOrder] = useState<
    Record<
      string,
      'CUSTOMER' | 'INVENTORY' | 'FRAUD' | 'DECLINED' | 'OTHER' | 'STAFF'
    >
  >({});
  const [cancelRefundMethodByOrder, setCancelRefundMethodByOrder] = useState<
    Record<string, 'ORIGINAL' | 'STORE_CREDIT'>
  >({});
  const [cancelStaffNoteByOrder, setCancelStaffNoteByOrder] = useState<
    Record<string, string>
  >({});
  const [printifyAddressConfirmed, setPrintifyAddressConfirmed] = useState<
    Record<string, boolean>
  >({});
  const [printifyAddressNeedsUpdate, setPrintifyAddressNeedsUpdate] = useState<
    Record<string, boolean>
  >({});
  const [printifyWarningOrderId, setPrintifyWarningOrderId] = useState<
    string | null
  >(null);
  const [confirmingPrintifyId, setConfirmingPrintifyId] = useState<
    string | null
  >(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [trackingData, setTrackingData] = useState<Record<string, {
    loading: boolean;
    error?: string;
    cached?: boolean;
    cachedAt?: string;
    data?: {
      status: string;
      statusDescription: string;
      estimatedDelivery?: string;
      deliveredAt?: string;
      shippedAt?: string;
      labelCreatedAt?: string;
      lastUpdate?: string;
      origin?: string;
      destination?: string;
      events: Array<{ date: string; description: string; location?: string }>;
    };
  }>>({});
  const [printifySupportOrderId, setPrintifySupportOrderId] = useState<string | null>(null);
  const [supportMessageCopied, setSupportMessageCopied] = useState(false);
  const [replacementModalOrderId, setReplacementModalOrderId] = useState<
    string | null
  >(null);
  const replacementOrder = data?.orders?.find(
    (order) => order.id === replacementModalOrderId
  );
  const [replacementItems, setReplacementItems] = useState<
    Record<string, ReplacementLineItem[]>
  >({});
  const [replacementNotes, setReplacementNotes] = useState<
    Record<string, string>
  >({});
  const [replacementTags, setReplacementTags] = useState<
    Record<string, string>
  >({});
  const [replacementReasons, setReplacementReasons] = useState<
    Record<string, string>
  >({});
  const [replacementDiscountType, setReplacementDiscountType] = useState<
    Record<string, 'PERCENTAGE' | 'FIXED_AMOUNT'>
  >({});
  const [replacementDiscountValue, setReplacementDiscountValue] = useState<
    Record<string, string>
  >({});
  const [replacementTaxExempt, setReplacementTaxExempt] = useState<
    Record<string, boolean>
  >({});

  const [replacementCustomerSearch, setReplacementCustomerSearch] =
    useState('');
  const [replacementCustomerResults, setReplacementCustomerResults] = useState<
    ShopifyCustomer[]
  >([]);
  const [replacementCustomerSearching, setReplacementCustomerSearching] =
    useState(false);
  const [replacementSelectedCustomer, setReplacementSelectedCustomer] =
    useState<Record<string, ShopifyCustomer | null>>({});
  const [showCustomerSearch, setShowCustomerSearch] = useState<
    Record<string, boolean>
  >({});
  const [editingShipping, setEditingShipping] = useState<
    Record<string, boolean>
  >({});
  const [editingBilling, setEditingBilling] = useState<
    Record<string, boolean>
  >({});
  const [replacementShippingAddress, setReplacementShippingAddress] = useState<
    Record<string, ShopifyAddress>
  >({});
  const [replacementBillingAddress, setReplacementBillingAddress] = useState<
    Record<string, ShopifyAddress>
  >({});
  const [replacementSearchSelection, setReplacementSearchSelection] = useState<
    Record<string, { color?: string; size?: string; variantId?: string }>
  >({});
  const replacementSearchSelectionRef = useRef<
    Record<string, { color?: string; size?: string; variantId?: string }>
  >({});
  const [creatingReplacement, setCreatingReplacement] = useState<string | null>(
    null
  );
  const [variantOptions, setVariantOptions] = useState<
    Record<string, ProductVariantsResponse>
  >({});
  const [loadingVariants, setLoadingVariants] = useState<
    Record<string, boolean>
  >({});

  const [replacementProductSearch, setReplacementProductSearch] = useState('');
  const [replacementSearchResults, setReplacementSearchResults] = useState<
    SearchProduct[]
  >([]);
  const [replacementSearching, setReplacementSearching] = useState(false);
  const variantFetchRef = useRef<
    Record<string, Promise<ProductVariantsResponse | null> | null>
  >({});
  const [replacementShippingRates, setReplacementShippingRates] = useState<
    Record<string, ShippingRateOption[]>
  >({});
  const [replacementShippingRateSelection, setReplacementShippingRateSelection] =
    useState<Record<string, string>>({});
  const [replacementShippingRatesLoading, setReplacementShippingRatesLoading] =
    useState<Record<string, boolean>>({});

  // Edit Order Modal State
  const [editOrderModalId, setEditOrderModalId] = useState<string | null>(null);
  const editOrderData = data?.orders?.find((order) => order.id === editOrderModalId);
  const [editOrderItems, setEditOrderItems] = useState<
    Record<string, ReplacementLineItem[]>
  >({});
  const [editOrderProductSearch, setEditOrderProductSearch] = useState('');
  const [editOrderSearchResults, setEditOrderSearchResults] = useState<
    SearchProduct[]
  >([]);
  const [editOrderSearching, setEditOrderSearching] = useState(false);
  const [editOrderNote, setEditOrderNote] = useState<Record<string, string>>({});
  const [editingOrder, setEditingOrder] = useState<string | null>(null);
  const [editOrderNotifyCustomer, setEditOrderNotifyCustomer] = useState<Record<string, boolean>>({});
  const [editOrderSuccessId, setEditOrderSuccessId] = useState<string | null>(null);
  const [editOrderSuccessName, setEditOrderSuccessName] = useState<string | null>(null);
  const [editOrderPrintifyAcknowledged, setEditOrderPrintifyAcknowledged] = useState(false);

  useEffect(() => {
    replacementSearchSelectionRef.current = replacementSearchSelection;
  }, [replacementSearchSelection]);

  const updateReplacementSearchSelection = (
    productId: string,
    updates: { color?: string; size?: string; variantId?: string }
  ) => {
    setReplacementSearchSelection((prev) => {
      const next = {
        ...prev,
        [productId]: {
          ...prev[productId],
          ...updates,
        },
      };
      replacementSearchSelectionRef.current = next;
      return next;
    });
  };

  const loadVariantsForProduct = async (productId: string) => {
    if (variantOptions[productId]) {
      return variantOptions[productId];
    }
    if (variantFetchRef.current[productId]) {
      return variantFetchRef.current[productId];
    }

    const fetchPromise = (async () => {
      setLoadingVariants((prev) => ({ ...prev, [productId]: true }));
      try {
        const res = await fetch(
          `/api/shopify/products/${encodeURIComponent(productId)}/variants`
        );
        if (!res.ok) return null;
        const data = (await res.json()) as ProductVariantsResponse;
        setVariantOptions((prev) => ({ ...prev, [productId]: data }));
        return data;
      } catch {
        return null;
      } finally {
        setLoadingVariants((prev) => ({ ...prev, [productId]: false }));
      }
    })();

    variantFetchRef.current[productId] = fetchPromise;
    const result = await fetchPromise;
    variantFetchRef.current[productId] = null;
    return result;
  };

  // Refund state
  const [refundModalOrderId, setRefundModalOrderId] = useState<string | null>(null);
  const refundModalOrder = data?.orders?.find((order) => order.id === refundModalOrderId);
  const [refundLineItems, setRefundLineItems] = useState<Record<string, Record<string, number>>>({});
  const [refundReason, setRefundReason] = useState<Record<string, string>>({});
  const [refundShipping, setRefundShipping] = useState<Record<string, boolean>>({});
  const [refundShippingAmount, setRefundShippingAmount] = useState<Record<string, string>>({});
  const [refundMethod, setRefundMethod] = useState<Record<string, 'ORIGINAL' | 'STORE_CREDIT'>>({});
  const [refundNotify, setRefundNotify] = useState<Record<string, boolean>>({});
  const [refundingOrderId, setRefundingOrderId] = useState<string | null>(null);

  const getPrintifyMatch = (orderId: string) => {
    return data?.printifyOrders?.find((p) => p.shopifyOrderId === orderId);
  };

  useEffect(() => {
    if (!replacementModalOrderId) {
      setReplacementProductSearch('');
      setReplacementSearchResults([]);
      return;
    }

    if (replacementProductSearch.trim().length < 2) {
      setReplacementSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setReplacementSearching(true);
      try {
        const res = await fetch(
          `/api/shopify/products/search?q=${encodeURIComponent(
            replacementProductSearch.trim()
          )}&limit=6`
        );
        if (res.ok) {
          const data = await res.json();
          const products = (data.products || []) as SearchProduct[];
          const query = replacementProductSearch.trim();
          const sorted = [...products].sort((a, b) => {
            const scoreA = getMatchScore(a.title, query);
            const scoreB = getMatchScore(b.title, query);
            return scoreB - scoreA;
          });
          setReplacementSearchResults(sorted);
        }
      } catch {
        // Ignore search errors
      } finally {
        setReplacementSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [replacementModalOrderId, replacementProductSearch]);

  // Edit Order Product Search Effect
  useEffect(() => {
    if (!editOrderModalId) {
      setEditOrderProductSearch('');
      setEditOrderSearchResults([]);
      return;
    }

    if (editOrderProductSearch.trim().length < 2) {
      setEditOrderSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setEditOrderSearching(true);
      try {
        const res = await fetch(
          `/api/shopify/products/search?q=${encodeURIComponent(
            editOrderProductSearch.trim()
          )}&limit=6`
        );
        if (res.ok) {
          const data = await res.json();
          const products = (data.products || []) as SearchProduct[];
          const query = editOrderProductSearch.trim();
          const sorted = [...products].sort((a, b) => {
            const scoreA = getMatchScore(a.title, query);
            const scoreB = getMatchScore(b.title, query);
            return scoreB - scoreA;
          });
          setEditOrderSearchResults(sorted);
        }
      } catch {
        // Ignore search errors
      } finally {
        setEditOrderSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [editOrderModalId, editOrderProductSearch]);

  useEffect(() => {
    if (!replacementModalOrderId) {
      setReplacementCustomerSearch('');
      setReplacementCustomerResults([]);
      return;
    }

    if (replacementCustomerSearch.trim().length < 2) {
      setReplacementCustomerResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setReplacementCustomerSearching(true);
      try {
        const res = await fetch(
          `/api/shopify/customers/search?q=${encodeURIComponent(
            replacementCustomerSearch.trim()
          )}&limit=6`
        );
        if (res.ok) {
          const data = await res.json();
          setReplacementCustomerResults(data.customers || []);
        }
      } catch {
        // Ignore search errors
      } finally {
        setReplacementCustomerSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [replacementModalOrderId, replacementCustomerSearch]);

  const replacementShippingCountry =
    (replacementModalOrderId &&
      (replacementShippingAddress[replacementModalOrderId]?.countryCode ||
        replacementShippingAddress[replacementModalOrderId]?.country ||
        replacementOrder?.shippingAddress?.countryCode ||
        replacementOrder?.shippingAddress?.country)) ||
    '';

  useEffect(() => {
    if (!replacementModalOrderId) return;
    if (!replacementShippingCountry) {
      setReplacementShippingRates((prev) => ({
        ...prev,
        [replacementModalOrderId]: [],
      }));
      setReplacementShippingRateSelection((prev) => ({
        ...prev,
        [replacementModalOrderId]: '',
      }));
      return;
    }

    setReplacementShippingRatesLoading((prev) => ({
      ...prev,
      [replacementModalOrderId]: true,
    }));

    fetch(
      `/api/shopify/shipping-rates?country=${encodeURIComponent(
        replacementShippingCountry
      )}`
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const rates = (data?.rates || []) as ShippingRateOption[];
        setReplacementShippingRates((prev) => ({
          ...prev,
          [replacementModalOrderId]: rates,
        }));
        setReplacementShippingRateSelection((prev) => ({
          ...prev,
          [replacementModalOrderId]:
            prev[replacementModalOrderId] &&
            rates.some((rate) => rate.id === prev[replacementModalOrderId])
              ? prev[replacementModalOrderId]
              : '',
        }));
      })
      .catch(() => {
        setReplacementShippingRates((prev) => ({
          ...prev,
          [replacementModalOrderId]: [],
        }));
      })
      .finally(() => {
        setReplacementShippingRatesLoading((prev) => ({
          ...prev,
          [replacementModalOrderId]: false,
        }));
      });
  }, [replacementModalOrderId, replacementShippingCountry]);

  // Load full variants for all search results sequentially to avoid API overload
  useEffect(() => {
    if (!replacementModalOrderId) return;
    if (!replacementSearchResults.length) return;

    // Load variants sequentially (one at a time) to avoid overwhelming the API
    const loadVariantsSequentially = async () => {
      for (const product of replacementSearchResults) {
        if (
          product.id &&
          !variantOptions[product.id] &&
          !loadingVariants[product.id]
        ) {
          await loadVariantsForProduct(product.id);
        }
      }
    };

    loadVariantsSequentially();
  }, [replacementModalOrderId, replacementSearchResults]);

  const startEditAddress = (order: ShopifyOrder, printify?: PrintifyOrderMatch) => {
    setEditingAddress((prev) => ({ ...prev, [order.id]: true }));
    setAddressEdits((prev) => ({
      ...prev,
      [order.id]: {
        ...emptyShopifyAddress,
        ...order.shippingAddress,
      },
    }));
  };

  const cancelEditAddress = (orderId: string) => {
    setEditingAddress((prev) => ({ ...prev, [orderId]: false }));
    setActionError(null);
    setActionNote(null);
  };

  const saveAddress = async (
    orderId: string,
    printifyOrderId?: string
  ) => {
    setSavingAddressFor(orderId);
    setActionError(null);
    setActionNote(null);

    const shopifyAddress = addressEdits[orderId] || emptyShopifyAddress;

    const res = await fetch(`/api/threads/${threadId}/orders/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'update_shipping',
        orderId,
        shopifyAddress,
        printifyOrderId,
      }),
    });

    const result = await res.json();
    if (!res.ok || !result.shopify?.success) {
      setActionError(
        result.shopify?.errors?.join(', ') ||
          result.error ||
          'Failed to update address'
      );
      setSavingAddressFor(null);
      return;
    }

    if (result.printifyMessage) {
      setActionNote(result.printifyMessage);
    } else {
      setActionNote(
        printifyOrderId
          ? 'Shopify updated. Update Printify manually.'
          : 'Address updated.'
      );
    }

    if (printifyOrderId) {
      setPrintifyAddressNeedsUpdate((prev) => ({
        ...prev,
        [orderId]: true,
      }));
      setPrintifyAddressConfirmed((prev) => ({
        ...prev,
        [orderId]: false,
      }));
      setPrintifyWarningOrderId(orderId);
    }

    setEditingAddress((prev) => ({ ...prev, [orderId]: false }));
    setSavingAddressFor(null);
    refetch();
  };

  const cancelShopifyOrder = async (orderId: string) => {
    setCancelingShopifyId(orderId);
    setActionError(null);
    setActionNote(null);
    const staffNote = (cancelStaffNoteByOrder[orderId] || '').trim();
    const res = await fetch(`/api/threads/${threadId}/orders/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'cancel_shopify',
        orderId,
        reason: cancelReasonByOrder[orderId] || 'CUSTOMER',
        refundMethod: cancelRefundMethodByOrder[orderId] || 'ORIGINAL',
        staffNote: staffNote.length > 0 ? staffNote : undefined,
      }),
    });
    const result = await res.json();
    if (!res.ok || !result.success) {
      const errors = result.errors || [];
      const normalizedErrors = Array.isArray(errors)
        ? [...new Set(errors)]
        : [];
      setActionError(
        normalizedErrors.join(', ') || result.error || 'Cancel failed'
      );
    } else {
      setActionNote('Shopify order cancelled with full refund.');
      refetch();
      setCancelModalOrderId((prev) => (prev === orderId ? null : prev));
    }
    setCancelingShopifyId(null);
  };

  const fetchTrackingDetails = async (trackingNumber: string, carrier: string, refresh = false) => {
    const key = `${carrier}-${trackingNumber}`;
    setTrackingData((prev) => ({
      ...prev,
      [key]: { ...prev[key], loading: true },
    }));

    try {
      const res = await fetch('/api/tracking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackingNumber, carrier, refresh }),
      });
      const result = await res.json();
      if (!res.ok) {
        setTrackingData((prev) => ({
          ...prev,
          [key]: { loading: false, error: result.error || 'Failed to fetch tracking' },
        }));
      } else {
        setTrackingData((prev) => ({
          ...prev,
          [key]: {
            loading: false,
            data: result,
            cached: result._cached,
            cachedAt: result._cachedAt,
          },
        }));
      }
    } catch (err) {
      setTrackingData((prev) => ({
        ...prev,
        [key]: { loading: false, error: err instanceof Error ? err.message : 'Failed to fetch tracking' },
      }));
    }
  };

  // Track which shipments we've already fetched to avoid duplicate calls
  const fetchedTrackingRef = useRef<Set<string>>(new Set());

  // Auto-load cached tracking data for orders with shipments
  // Also refresh if Printify shows delivered but our cache doesn't
  useEffect(() => {
    if (!data?.orders || !data?.printifyOrders) return;

    data.orders.forEach((order) => {
      const printifyMatch = data.printifyOrders?.find((p) => p.shopifyOrderId === order.id);
      if (!printifyMatch?.order?.shipments?.length) return;

      printifyMatch.order.shipments.forEach((shipment: { number?: string; carrier?: string; delivered_at?: string }) => {
        if (!shipment.number || !shipment.carrier) return;

        const key = `${shipment.carrier}-${shipment.number}`;

        // Skip if we've already fetched this shipment in this session
        if (fetchedTrackingRef.current.has(key)) return;

        // Mark as fetched
        fetchedTrackingRef.current.add(key);

        // Fetch tracking data (will use cache if available)
        fetchTrackingDetails(shipment.number, shipment.carrier);
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.orders, data?.printifyOrders]);

  // Handle refresh when Printify shows delivered but cache doesn't
  useEffect(() => {
    if (!data?.orders || !data?.printifyOrders) return;

    data.orders.forEach((order) => {
      const printifyMatch = data.printifyOrders?.find((p) => p.shopifyOrderId === order.id);
      if (!printifyMatch?.order?.shipments?.length) return;

      printifyMatch.order.shipments.forEach((shipment: { number?: string; carrier?: string; delivered_at?: string }) => {
        if (!shipment.number || !shipment.carrier) return;

        const key = `${shipment.carrier}-${shipment.number}`;
        const existing = trackingData[key];

        // Check if we need to refresh based on Printify status
        const printifyShowsDelivered = !!shipment.delivered_at;
        const cacheShowsDelivered = !!existing?.data?.deliveredAt;

        if (existing && printifyShowsDelivered && !cacheShowsDelivered && !existing.loading) {
          // Printify shows delivered but our cache doesn't - force refresh
          fetchTrackingDetails(shipment.number, shipment.carrier, true);
        }
      });
    });
  }, [data?.orders, data?.printifyOrders, trackingData]);

  const openCancelModal = (order: ShopifyOrder) => {
    if (order.cancelledAt) {
      setActionError('This order is already canceled.');
      return;
    }
    setCancelModalOrderId(order.id);
    setActionError(null);
    setActionNote(null);
    setCancelReasonByOrder((prev) => ({
      ...prev,
      [order.id]: prev[order.id] || 'CUSTOMER',
    }));
    setCancelRefundMethodByOrder((prev) => ({
      ...prev,
      [order.id]: prev[order.id] || 'ORIGINAL',
    }));
  };

  const openRefundModal = (order: ShopifyOrder) => {
    if (order.cancelledAt) {
      setActionError('Cannot refund a cancelled order.');
      return;
    }
    setRefundModalOrderId(order.id);
    setActionError(null);
    setActionNote(null);

    const shipping = order.totalShippingPrice ? parseFloat(order.totalShippingPrice) : 0;

    // Initialize line items for refund (default to 0 - nothing selected)
    setRefundLineItems((prev) => {
      if (prev[order.id]) return prev;
      const items: Record<string, number> = {};
      order.lineItems.forEach((item) => {
        items[item.id] = 0;
      });
      return { ...prev, [order.id]: items };
    });
    setRefundShipping((prev) => ({
      ...prev,
      [order.id]: prev[order.id] ?? false,
    }));
    setRefundShippingAmount((prev) => ({
      ...prev,
      [order.id]: prev[order.id] ?? shipping.toFixed(2),
    }));
    setRefundMethod((prev) => ({
      ...prev,
      [order.id]: prev[order.id] ?? 'ORIGINAL',
    }));
    setRefundNotify((prev) => ({
      ...prev,
      [order.id]: prev[order.id] ?? true,
    }));
  };

  const submitRefund = async (order: ShopifyOrder) => {
    setRefundingOrderId(order.id);
    setActionError(null);
    setActionNote(null);

    const shouldRefundShipping = refundShipping[order.id] ?? false;
    const shippingAmt = shouldRefundShipping ? refundShippingAmount[order.id] : undefined;

    // Calculate refund amount from selected line items
    const lineItemQuantities = refundLineItems[order.id] || {};
    let itemsRefundAmount = 0;
    const refundLineItemsList: { lineItemId: string; quantity: number }[] = [];

    order.lineItems.forEach((item) => {
      const qty = lineItemQuantities[item.id] || 0;
      if (qty > 0) {
        const unitPrice = parseFloat(item.originalUnitPrice || '0');
        itemsRefundAmount += unitPrice * qty;
        refundLineItemsList.push({ lineItemId: item.id, quantity: qty });
      }
    });

    if (refundLineItemsList.length === 0 && !shouldRefundShipping) {
      setActionError('Please select at least one item to refund or refund shipping.');
      setRefundingOrderId(null);
      return;
    }

    try {
      const res = await fetch(`/api/threads/${threadId}/orders/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'refund',
          orderId: order.id,
          amount: itemsRefundAmount > 0 ? itemsRefundAmount.toFixed(2) : undefined,
          lineItems: refundLineItemsList,
          reason: refundReason[order.id] || undefined,
          refundShipping: shouldRefundShipping,
          shippingAmount: shippingAmt,
          refundMethod: refundMethod[order.id] || 'ORIGINAL',
          notify: refundNotify[order.id] ?? true,
        }),
      });

      const result = await res.json();
      if (!res.ok || !result.success) {
        setActionError(result.error || 'Refund failed');
      } else {
        setRefundModalOrderId(null);
        setActionNote(`Refunded ${result.refundedAmount ? `$${result.refundedAmount}` : 'order'} successfully.`);
        refetch();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Refund failed');
    } finally {
      setRefundingOrderId(null);
    }
  };

  const cancelPrintifyOrder = async (
    printifyOrderId: string,
    orderLabel?: string,
    orderStatus?: string,
    cancelUrl?: string
  ) => {
    setCancelingPrintifyId(printifyOrderId);
    setActionError(null);
    setActionNote(null);
    setPrintifyCancelLink(null);
    const res = await fetch(`/api/threads/${threadId}/orders/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel_printify', printifyOrderId }),
    });
    const result = await res.json();
    if (!res.ok || !result.success) {
      const rawError = result.error || 'Cancel failed';
      const statusInfo = orderStatus ? ` (status: ${orderStatus})` : '';
      if (
        rawError.includes('code":8501') ||
        rawError.toLowerCase().includes('does not allow cancellation')
      ) {
        setActionError(
          `Printify API can’t cancel at this status${statusInfo}. Use Printify to request cancellation.`
        );
        if (cancelUrl) {
          setPrintifyCancelLink(cancelUrl);
        }
      } else {
        setActionError(rawError);
      }
    } else {
      const label = orderLabel ? ` (${orderLabel})` : '';
      setActionNote(`Printify order cancelled${label}.`);
      refetch();
      setTimeout(() => {
        refetch();
      }, 8000);
    }
    setCancelingPrintifyId(null);
  };

  const confirmPrintifyAddress = async (
    orderId: string,
    printifyOrderId?: string
  ) => {
    setConfirmingPrintifyId(orderId);
    try {
      const res = await fetch(`/api/threads/${threadId}/orders/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'confirm_printify_address',
          orderId,
          printifyOrderId,
        }),
      });
      const result = await res.json();
      if (!res.ok || !result.success) {
        setActionError(result.error || 'Failed to confirm Printify update');
        setPrintifyAddressConfirmed((prev) => ({
          ...prev,
          [orderId]: false,
        }));
        setPrintifyAddressNeedsUpdate((prev) => ({
          ...prev,
          [orderId]: true,
        }));
      } else {
        setActionNote('Printify address update confirmed.');
        setPrintifyAddressConfirmed((prev) => ({
          ...prev,
          [orderId]: true,
        }));
      }
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Failed to confirm Printify update'
      );
      setPrintifyAddressConfirmed((prev) => ({
        ...prev,
        [orderId]: false,
      }));
      setPrintifyAddressNeedsUpdate((prev) => ({
        ...prev,
        [orderId]: true,
      }));
    } finally {
      setConfirmingPrintifyId(null);
    }
  };

  const closePrintifyWarning = () => {
    if (!printifyWarningOrderId) return;
    if (!printifyAddressConfirmed[printifyWarningOrderId]) return;
    setPrintifyAddressNeedsUpdate((prev) => ({
      ...prev,
      [printifyWarningOrderId]: false,
    }));
    setPrintifyWarningOrderId(null);
  };

  const openReplacement = async (order: ShopifyOrder) => {
    setActionError(null);
    setActionNote(null);
    setReplacementModalOrderId(order.id);

    setReplacementItems((prev) => {
      if (prev[order.id]) return prev;
      const initial = order.lineItems
        .filter((li) => li.variantId)
        .map((li) => ({
          id: li.id,
          productId: li.productId,
          title: li.title,
          variantId: li.variantId as string,
          variantTitle: li.variantTitle || 'Default',
          quantity: li.quantity,
          imageUrl: li.variantImageUrl || li.imageUrl,
          selectedOptions: li.selectedOptions,
          price: li.originalUnitPrice,
          sku: li.sku,
        }));
      return { ...prev, [order.id]: initial };
    });

    setReplacementReasons((prev) => ({
      ...prev,
      [order.id]: prev[order.id] || 'Size exchange',
    }));
    setReplacementDiscountType((prev) => ({
      ...prev,
      [order.id]: prev[order.id] || 'PERCENTAGE',
    }));
    setReplacementDiscountValue((prev) => ({
      ...prev,
      [order.id]: prev[order.id] || '100',
    }));
    setReplacementTaxExempt((prev) => ({
      ...prev,
      [order.id]: prev[order.id] ?? true,
    }));
    setReplacementShippingRateSelection((prev) => ({
      ...prev,
      [order.id]: prev[order.id] || '',
    }));
    setReplacementShippingAddress((prev) => ({
      ...prev,
      [order.id]: order.shippingAddress || emptyShopifyAddress,
    }));
    setReplacementBillingAddress((prev) => ({
      ...prev,
      [order.id]: order.billingAddress || emptyShopifyAddress,
    }));
    setReplacementSelectedCustomer((prev) => ({
      ...prev,
      [order.id]: customer || null,
    }));

    const productIds = Array.from(
      new Set(order.lineItems.map((li) => li.productId).filter(Boolean))
    ) as string[];

    await Promise.all(
      productIds.map(async (productId) => {
        if (variantOptions[productId] || loadingVariants[productId]) return;
        setLoadingVariants((prev) => ({ ...prev, [productId]: true }));
        const res = await fetch(
          `/api/shopify/products/${encodeURIComponent(productId)}/variants`
        );
        if (res.ok) {
          const data = (await res.json()) as ProductVariantsResponse;
          setVariantOptions((prev) => ({ ...prev, [productId]: data }));
        }
        setLoadingVariants((prev) => ({ ...prev, [productId]: false }));
      })
    );
  };

  const createReplacement = async (order: ShopifyOrder) => {
    setCreatingReplacement(order.id);
    setActionError(null);
    setActionNote(null);

    try {
      const items = replacementItems[order.id] || [];
      const selectedCustomer = replacementSelectedCustomer[order.id];
      const shippingOverride = replacementShippingAddress[order.id];
      const billingOverride = replacementBillingAddress[order.id];
      const shippingRates = replacementShippingRates[order.id] || [];
      const selectedShippingRate = shippingRates.find(
        (rate) => rate.id === replacementShippingRateSelection[order.id]
      );
      const lineItems = items.map((item) => ({
        variantId: item.variantId,
        quantity: item.quantity,
        requiresShipping: true,
      }));

      if (lineItems.length === 0) {
        setActionError('No replacement variants selected.');
        setCreatingReplacement(null);
        return;
      }

      console.log('[createReplacement] Starting API call for order:', order.id);
      const res = await fetch(`/api/threads/${threadId}/orders/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_replacement',
          orderId: order.id,
          lineItems,
          reason: replacementReasons[order.id] || 'Size exchange',
          note: replacementNotes[order.id],
          discountType: replacementDiscountType[order.id],
          discountValue: replacementDiscountValue[order.id],
          taxExempt: replacementTaxExempt[order.id],
          customerId: selectedCustomer?.id,
          email: selectedCustomer?.email,
          shippingAddress: shippingOverride,
          billingAddress: billingOverride,
          shippingLine: selectedShippingRate
            ? {
                title: selectedShippingRate.title,
                price: selectedShippingRate.price,
                currencyCode: selectedShippingRate.currencyCode,
              }
            : undefined,
          tags: replacementTags[order.id]
            ? replacementTags[order.id]
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean)
            : [],
        }),
      });

      console.log('[createReplacement] Response received, status:', res.status);
      const result = await res.json();
      console.log('[createReplacement] Parsed result:', result);
      if (!res.ok || result.success !== true) {
        console.log('[createReplacement] Error condition: res.ok=', res.ok, 'result.success=', result.success);
        setActionError(result.errors?.join(', ') || result.error || 'Create failed');
        return; // Early return on error
      }

      // Success - close modal first
      console.log('[createReplacement] Success! Closing modal...');
      const orderId = order.id;
      setReplacementModalOrderId(null);
      console.log('[createReplacement] Modal state set to null');

      // Clear all replacement form state for this order
      setReplacementItems((prev) => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
      setReplacementNotes((prev) => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
      setReplacementTags((prev) => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
      setReplacementReasons((prev) => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
      setReplacementDiscountType((prev) => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
      setReplacementDiscountValue((prev) => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
      setReplacementTaxExempt((prev) => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
      setReplacementSelectedCustomer((prev) => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
      setReplacementShippingAddress((prev) => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
      setReplacementBillingAddress((prev) => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
      setReplacementShippingRateSelection((prev) => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
      setShowCustomerSearch((prev) => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
      setEditingShipping((prev) => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
      setEditingBilling((prev) => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });

      // Clear search state
      setReplacementProductSearch('');
      setReplacementSearchResults([]);
      setReplacementCustomerSearch('');
      setReplacementCustomerResults([]);

      console.log('[createReplacement] Setting success note for order:', result.orderName);
      setActionNote(`Replacement order created (${result.orderName || 'new order'}).`);
      // Force fresh data fetch by incrementing refresh token
      setRefreshToken((prev) => prev + 1);
      console.log('[createReplacement] Triggered refresh token increment');
      // Also refetch after a delay for Printify sync
      setTimeout(() => {
        setRefreshToken((prev) => prev + 1);
      }, 15000);
    } catch (err) {
      console.error('[createReplacement] Caught error:', err);
      setActionError(err instanceof Error ? err.message : 'Failed to create replacement order');
    } finally {
      console.log('[createReplacement] Finally block - clearing loading state');
      setCreatingReplacement(null);
    }
  };

  const updateReplacementItem = (
    orderId: string,
    itemId: string,
    updates: Partial<ReplacementLineItem>
  ) => {
    setReplacementItems((prev) => ({
      ...prev,
      [orderId]: (prev[orderId] || []).map((item) =>
        item.id === itemId ? { ...item, ...updates } : item
      ),
    }));
  };

  const removeReplacementItem = (orderId: string, itemId: string) => {
    setReplacementItems((prev) => ({
      ...prev,
      [orderId]: (prev[orderId] || []).filter((item) => item.id !== itemId),
    }));
  };

  const addReplacementItem = (
    orderId: string,
    product: SearchProduct,
    variant: SearchProduct['variants'][0]
  ) => {
    const id = typeof crypto !== 'undefined' ? crypto.randomUUID() : `${Date.now()}-${variant.id}`;
    const newItem: ReplacementLineItem = {
      id,
      productId: product.id,
      title: product.title,
      variantId: variant.id,
      variantTitle: variant.title,
      quantity: 1,
      imageUrl: variant.imageUrl || product.imageUrl,
      selectedOptions: variant.selectedOptions,
      sku: variant.sku,
      price: variant.price,
    };

    setReplacementItems((prev) => ({
      ...prev,
      [orderId]: [...(prev[orderId] || []), newItem],
    }));
    setReplacementProductSearch('');
    setReplacementSearchResults([]);

    if (product.id && !variantOptions[product.id] && !loadingVariants[product.id]) {
      setLoadingVariants((prev) => ({ ...prev, [product.id]: true }));
      fetch(`/api/shopify/products/${encodeURIComponent(product.id)}/variants`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data) {
            setVariantOptions((prev) => ({ ...prev, [product.id]: data }));
          }
        })
        .finally(() =>
          setLoadingVariants((prev) => ({ ...prev, [product.id]: false }))
        );
    }
  };

  // Edit Order Functions
  const openEditOrder = async (order: ShopifyOrder) => {
    // Cannot edit cancelled or fulfilled orders
    if (order.cancelledAt) {
      setActionError('Cancelled orders cannot be edited.');
      return;
    }
    if (order.fulfillmentStatus?.toLowerCase() === 'fulfilled') {
      setActionError('Fulfilled orders cannot be edited.');
      return;
    }

    setActionError(null);
    setActionNote(null);
    setEditOrderModalId(order.id);

    setEditOrderItems((prev) => {
      if (prev[order.id]) return prev;
      const initial = order.lineItems
        .filter((li) => li.variantId)
        .map((li) => ({
          id: li.id,
          productId: li.productId,
          title: li.title,
          variantId: li.variantId as string,
          variantTitle: li.variantTitle || 'Default',
          quantity: li.quantity,
          imageUrl: li.variantImageUrl || li.imageUrl,
          selectedOptions: li.selectedOptions,
          price: li.originalUnitPrice,
          sku: li.sku,
          originalLineItemId: li.id, // Track original line item for removal
          originalVariantId: li.variantId as string, // Track original variant for size changes
          originalPrice: li.originalUnitPrice, // Track original price for discount calculation
        }));
      return { ...prev, [order.id]: initial };
    });

    // Load variants for existing products
    const productIds = Array.from(
      new Set(order.lineItems.map((li) => li.productId).filter(Boolean))
    ) as string[];

    await Promise.all(
      productIds.map(async (productId) => {
        if (variantOptions[productId] || loadingVariants[productId]) return;
        setLoadingVariants((prev) => ({ ...prev, [productId]: true }));
        const res = await fetch(
          `/api/shopify/products/${encodeURIComponent(productId)}/variants`
        );
        if (res.ok) {
          const varData = (await res.json()) as ProductVariantsResponse;
          setVariantOptions((prev) => ({ ...prev, [productId]: varData }));
        }
        setLoadingVariants((prev) => ({ ...prev, [productId]: false }));
      })
    );
  };

  const submitEditOrder = async (order: ShopifyOrder) => {
    setEditingOrder(order.id);
    setActionError(null);
    setActionNote(null);

    try {
      const currentItems = editOrderItems[order.id] || [];
      const originalItems = order.lineItems.filter((li) => li.variantId);

      // Find items to add:
      // 1. New items (no originalLineItemId)
      // 2. Existing items where variant changed (need to remove old + add new)
      const addItems = currentItems
        .filter((item) => {
          if (!item.originalLineItemId) return true; // New item
          // Variant changed on existing item
          return item.originalVariantId && item.variantId !== item.originalVariantId;
        })
        .map((item) => {
          // Calculate discount: if new price > original price, discount the difference
          let discount: string | undefined;
          if (item.originalPrice && item.price) {
            const originalPrice = parseFloat(item.originalPrice);
            const newPrice = parseFloat(item.price);
            if (newPrice > originalPrice) {
              // Auto-apply discount for price difference so customer isn't charged
              discount = (newPrice - originalPrice).toFixed(2);
            }
          }
          // Also include any manually set discount
          if (item.discount && parseFloat(item.discount) > 0) {
            discount = item.discount;
          }
          return {
            variantId: item.variantId,
            quantity: item.quantity,
            discount,
          };
        });

      // Find items to remove:
      // 1. Original items that were completely removed (not in current)
      // 2. Original items where variant changed (need to remove old + add new)
      const currentOriginalLineItemIds = new Set(
        currentItems.map((i) => i.originalLineItemId).filter(Boolean)
      );
      const variantChangedLineItemIds = currentItems
        .filter((item) => item.originalLineItemId && item.originalVariantId && item.variantId !== item.originalVariantId)
        .map((item) => item.originalLineItemId as string);

      const removeLineItemIds = [
        // Items completely removed
        ...originalItems
          .filter((li) => !currentOriginalLineItemIds.has(li.id))
          .map((li) => li.id),
        // Items where variant changed
        ...variantChangedLineItemIds,
      ];

      // Find items with changed quantities (only for items where variant stayed the same)
      const updateQuantities = currentItems
        .filter((item) => {
          if (!item.originalLineItemId) return false;
          // Don't update quantity if variant changed (we're removing + adding instead)
          if (item.originalVariantId && item.variantId !== item.originalVariantId) return false;
          const original = originalItems.find((oi) => oi.id === item.originalLineItemId);
          return original && original.quantity !== item.quantity;
        })
        .map((item) => ({
          lineItemId: item.originalLineItemId as string,
          quantity: item.quantity,
        }));

      // Check if there are any changes
      if (addItems.length === 0 && removeLineItemIds.length === 0 && updateQuantities.length === 0) {
        setActionNote('No changes to save.');
        setEditOrderModalId(null);
        setEditingOrder(null);
        return;
      }

      const res = await fetch(`/api/threads/${threadId}/orders/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'edit_order',
          orderId: order.id,
          addItems: addItems.length > 0 ? addItems : undefined,
          removeLineItemIds: removeLineItemIds.length > 0 ? removeLineItemIds : undefined,
          updateQuantities: updateQuantities.length > 0 ? updateQuantities : undefined,
          staffNote: editOrderNote[order.id] || 'Order edited via support desk',
          notifyCustomer: editOrderNotifyCustomer[order.id] ?? false,
        }),
      });

      const result = await res.json();
      if (!res.ok || !result.success) {
        setActionError(result.errors?.join(', ') || result.error || 'Edit failed');
      } else {
        setEditOrderModalId(null);
        // Clear cached items to force reload
        setEditOrderItems((prev) => {
          const { [order.id]: _, ...rest } = prev;
          return rest;
        });
        // Show success modal with Printify link
        setEditOrderSuccessId(order.id);
        setEditOrderSuccessName(result.orderName || order.name);
        setEditOrderPrintifyAcknowledged(false);
        refetch();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to edit order');
    } finally {
      setEditingOrder(null);
    }
  };

  const updateEditOrderItem = (
    orderId: string,
    itemId: string,
    updates: Partial<ReplacementLineItem>
  ) => {
    setEditOrderItems((prev) => ({
      ...prev,
      [orderId]: (prev[orderId] || []).map((item) =>
        item.id === itemId ? { ...item, ...updates } : item
      ),
    }));
  };

  const removeEditOrderItem = (orderId: string, itemId: string) => {
    setEditOrderItems((prev) => ({
      ...prev,
      [orderId]: (prev[orderId] || []).filter((item) => item.id !== itemId),
    }));
  };

  const addEditOrderItem = (
    orderId: string,
    product: SearchProduct,
    variant: SearchProduct['variants'][0]
  ) => {
    const id = typeof crypto !== 'undefined' ? crypto.randomUUID() : `${Date.now()}-${variant.id}`;
    const newItem: ReplacementLineItem = {
      id,
      productId: product.id,
      title: product.title,
      variantId: variant.id,
      variantTitle: variant.title,
      quantity: 1,
      imageUrl: variant.imageUrl || product.imageUrl,
      selectedOptions: variant.selectedOptions,
      sku: variant.sku,
      price: variant.price,
    };

    setEditOrderItems((prev) => ({
      ...prev,
      [orderId]: [...(prev[orderId] || []), newItem],
    }));
    setEditOrderProductSearch('');
    setEditOrderSearchResults([]);

    if (product.id && !variantOptions[product.id] && !loadingVariants[product.id]) {
      setLoadingVariants((prev) => ({ ...prev, [product.id]: true }));
      fetch(`/api/shopify/products/${encodeURIComponent(product.id)}/variants`)
        .then((res) => (res.ok ? res.json() : null))
        .then((varData) => {
          if (varData) {
            setVariantOptions((prev) => ({ ...prev, [product.id]: varData }));
          }
        })
        .finally(() =>
          setLoadingVariants((prev) => ({ ...prev, [product.id]: false }))
        );
    }
  };

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <RefreshCw className="w-6 h-6 text-gray-400 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-gray-700 p-4">
        <AlertCircle className="w-8 h-8 mb-2" />
        <p className="text-sm">Failed to load customer data</p>
        <button
          onClick={() => refetch()}
          className="mt-2 text-sm text-blue-700 hover:underline"
        >
          Try again
        </button>
      </div>
    );
  }

  const {
    customer,
    orders,
    printifySyncNeeded,
    storeDomain,
    printifyShopId,
    customerMatchMethod,
  } = data || {};
  const fallbackEmail = data?.thread?.customerEmail;
  const fallbackName = data?.thread?.customerName;
  const showNameMatchWarning =
    customerMatchMethod === 'name' || customerMatchMethod === 'order_name';
  const orderFallback = orders?.[0];
  const cancelModalOrder = orders?.find(
    (order) => order.id === cancelModalOrderId
  );
  const derivedName =
    getAddressDisplayName(orderFallback?.shippingAddress) ||
    getAddressDisplayName(orderFallback?.billingAddress) ||
    null;
  const displayName =
    customer?.displayName || derivedName || fallbackName || 'Unknown Customer';
  const displayEmail =
    customer?.email || orderFallback?.customerEmail || fallbackEmail || 'No email available';
  const orderCount = customer?.numberOfOrders ?? (orders?.length || 0);
  const totalSpentAmount =
    customer?.totalSpent ||
    (orders && orders.length > 0
      ? orders
          .reduce((sum, order) => sum + parseFloat(order.totalPrice || '0'), 0)
          .toFixed(2)
      : undefined);
  const totalSpentCurrency =
    customer?.totalSpentCurrency ||
    orderFallback?.totalPriceCurrency ||
    'USD';
  const totalSpentNumber = totalSpentAmount ? parseFloat(totalSpentAmount) : 0;
  const isVip = orderCount > 3 || totalSpentNumber > 150;
  const cancelRefundAmount =
    cancelModalOrder?.totalPrice
      ? formatCurrency(
          cancelModalOrder.totalPrice,
          cancelModalOrder.totalPriceCurrency || 'USD'
        )
      : null;
  const cancelShopifyOrderUrl =
    cancelModalOrder && storeDomain && cancelModalOrder.legacyResourceId
      ? `https://${storeDomain}/admin/orders/${cancelModalOrder.legacyResourceId}`
      : null;
  const warningOrder = printifyWarningOrderId
    ? orders?.find((order) => order.id === printifyWarningOrderId)
    : null;
  const warningPrintify = warningOrder
    ? getPrintifyMatch(warningOrder.id)
    : null;
  const warningPrintifyOrderUrl =
    warningPrintify && printifyShopId
      ? `https://printify.com/app/store/${printifyShopId}/order/${warningPrintify.order.id}`
      : warningPrintify
      ? `https://printify.com/app/order/${warningPrintify.order.id}`
      : null;

  return (
    <div className="h-full overflow-y-auto bg-white">
      <div className="p-4 border-b bg-gray-50">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-gray-900">Customer</h3>
          <button
            onClick={() => setRefreshToken((prev) => prev + 1)}
            disabled={isFetching}
            className="text-gray-500 hover:text-gray-700"
          >
            <RefreshCw className={cn('w-4 h-4', isFetching && 'animate-spin')} />
          </button>
        </div>
      </div>

      <div className="p-4 border-b">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center">
            <User className="w-6 h-6 text-blue-700" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="font-medium text-gray-900">{displayName}</p>
              {isVip && (
                <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                  VIP
                </span>
              )}
            </div>
            <p className="text-sm text-gray-700">{displayEmail}</p>
          </div>
        </div>

        {customer || (orders && orders.length > 0) ? (
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-gray-500" />
              <div>
                <p className="text-gray-700">Total spent</p>
                <p className="font-medium text-gray-900">
                  {totalSpentAmount
                    ? formatCurrency(totalSpentAmount, totalSpentCurrency)
                    : '—'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ShoppingBag className="w-4 h-4 text-gray-500" />
              <div>
                <p className="text-gray-700">Orders</p>
                <p className="font-medium text-gray-900">
                  {orderCount}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-2 text-sm text-gray-700">
            No Shopify customer match for this email.
          </div>
        )}


        {customer?.tags?.length ? (
          <div className="mt-3 flex flex-wrap gap-1">
            {customer.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-gray-800 text-xs rounded"
              >
                <Tag className="w-3 h-3" />
                {tag}
              </span>
            ))}
          </div>
        ) : null}

        {customer?.note && (
          <div className="mt-3 p-2 bg-yellow-50 text-yellow-900 text-sm rounded">
            {customer.note}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-t border-b">
        <button
          onClick={() => setActiveTab('orders')}
          className={cn(
            'flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors',
            activeTab === 'orders'
              ? 'bg-white text-blue-600 border-b-2 border-blue-600'
              : 'bg-gray-50 text-gray-600 hover:text-gray-900 hover:bg-gray-100'
          )}
        >
          <Package className="w-4 h-4" />
          Orders ({orders?.length || 0})
        </button>
        <button
          onClick={() => setActiveTab('reviews')}
          className={cn(
            'flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors',
            activeTab === 'reviews'
              ? 'bg-white text-blue-600 border-b-2 border-blue-600'
              : 'bg-gray-50 text-gray-600 hover:text-gray-900 hover:bg-gray-100'
          )}
        >
          <Star className="w-4 h-4" />
          Reviews ({reviewsData?.totalCount || 0})
        </button>
      </div>

      {/* Orders Tab Content */}
      {activeTab === 'orders' && (
      <div className="p-4">
        {showNameMatchWarning && (
          <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Matched by name only — please double-check this order.
          </div>
        )}
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-900">
            Orders ({orders?.length || 0})
          </h3>
          {orders && orders.length > 1 && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setCurrentOrderIndex(Math.max(0, currentOrderIndex - 1))}
                disabled={currentOrderIndex === 0}
                className="p-1 rounded border border-gray-200 text-gray-700 hover:bg-gray-100 disabled:text-gray-300 disabled:border-gray-100 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-sm text-gray-600 min-w-[3rem] text-center">
                {currentOrderIndex + 1} / {orders.length}
              </span>
              <button
                onClick={() => setCurrentOrderIndex(Math.min(orders.length - 1, currentOrderIndex + 1))}
                disabled={currentOrderIndex === orders.length - 1}
                className="p-1 rounded border border-gray-200 text-gray-700 hover:bg-gray-100 disabled:text-gray-300 disabled:border-gray-100 disabled:cursor-not-allowed"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {printifySyncNeeded && (
          <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
            Printify orders haven&apos;t been synced yet. Go to Integrations →
            Printify and click "Sync Printify Orders".
          </div>
        )}

        {actionError && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <div>{actionError}</div>
            {printifyCancelLink && (
              <button
                onClick={() => window.open(printifyCancelLink, '_blank')}
                className="mt-2 inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
              >
                Open Printify to cancel
              </button>
            )}
          </div>
        )}

        {actionNote && (
          <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
            {actionNote}
          </div>
        )}

        {orders?.length === 0 ? (
          <p className="text-sm text-gray-700">No orders found</p>
        ) : (
          <div className="space-y-4">
            {(() => {
              // Sort orders by date (most recent first) and get current order
              const sortedOrders = [...(orders || [])].sort(
                (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
              );
              const order = sortedOrders[currentOrderIndex];
              if (!order) return null;
              const printify = getPrintifyMatch(order.id);
              const shopifyOrderUrl =
                storeDomain && order.legacyResourceId
                  ? `https://${storeDomain}/admin/orders/${order.legacyResourceId}`
                  : null;
              const printifyOrderUrl =
                printifyShopId && printify
                  ? `https://printify.com/app/store/${printifyShopId}/order/${printify.order.id}`
                  : printify
                  ? `https://printify.com/app/order/${printify.order.id}`
                  : null;
              const isPrintifyLocked = isPrintifyInProduction(printify);
              const isShopifyCancelled = Boolean(order.cancelledAt);

              return (
                <div className="border rounded-lg overflow-hidden">
                  <div className="p-2 border-b bg-white">
                    <div className="flex flex-wrap gap-1">
                      <Button
                        size="xs"
                        variant={isShopifyCancelled ? 'ghost' : 'danger'}
                        disabled={isShopifyCancelled}
                        loading={cancelingShopifyId === order.id}
                        onClick={() => openCancelModal(order)}
                      >
                        <ShieldX className="w-3 h-3 mr-1" />
                        {isShopifyCancelled ? 'Cancelled' : 'Cancel Order'}
                      </Button>
                    </div>
                  </div>
                  <div className="px-3 py-2 border-b bg-white flex items-center justify-between">
                    <p className="text-xs text-gray-600 uppercase tracking-wide">
                      Order links
                    </p>
                    <div className="flex items-center gap-2">
                      {shopifyOrderUrl && (
                        <button
                          onClick={() => window.open(shopifyOrderUrl, '_blank')}
                          className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                        >
                          <img
                            src="/shopify-logo.svg"
                            alt="Shopify"
                            className="h-4 w-4"
                          />
                          Shopify
                        </button>
                      )}
                      {printifyOrderUrl && (
                        <button
                          onClick={() => window.open(printifyOrderUrl, '_blank')}
                          className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                        >
                          <img
                            src="/printify-logo.svg"
                            alt="Printify"
                            className="h-4 w-4"
                          />
                          Printify
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="p-3 bg-gray-50 border-b">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={getStatusColor(order.financialStatus)}>
                          {order.financialStatus}
                        </Badge>
                        {order.cancelledAt && (
                          <Badge variant="error">Cancelled</Badge>
                        )}
                        {(() => {
                          const tracking = getTrackingStatus(order);
                          const variant =
                            tracking === 'Delivered'
                              ? 'success'
                              : tracking === 'In transit'
                              ? 'info'
                              : 'warning';
                          return (
                            <Badge variant={variant}>Tracking: {tracking}</Badge>
                          );
                        })()}
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-medium text-gray-900">
                          {order.name}
                        </div>
                        <div className="text-xs text-gray-600">
                          {formatDate(order.createdAt)}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-sm font-medium text-gray-900">
                        {formatCurrency(order.totalPrice, order.totalPriceCurrency)}
                      </span>
                    </div>
                  </div>

                  <div className="p-2 border-b">
                    <p className="text-xs text-gray-700 uppercase tracking-wide mb-1.5">
                      Quick actions
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => openReplacement(order)}
                      >
                        <Repeat className="w-3 h-3 mr-1" />
                        Replace
                      </Button>
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => openEditOrder(order)}
                        disabled={Boolean(order.cancelledAt) || order.fulfillmentStatus?.toLowerCase() === 'fulfilled'}
                        title={order.cancelledAt ? 'Cancelled orders cannot be edited' : order.fulfillmentStatus?.toLowerCase() === 'fulfilled' ? 'Fulfilled orders cannot be edited' : undefined}
                      >
                        <Pencil className="w-3 h-3 mr-1" />
                        Edit
                      </Button>
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => openRefundModal(order)}
                        disabled={Boolean(order.cancelledAt)}
                        title={order.cancelledAt ? 'Cancelled orders cannot be refunded' : undefined}
                      >
                        <DollarSign className="w-3 h-3 mr-1" />
                        Refund
                      </Button>
                    </div>
                  </div>

                  <div className="p-3 border-b">
                    <p className="text-xs text-gray-700 uppercase tracking-wide mb-2">
                      Items
                    </p>
                    <ul className="space-y-2">
                      {order.lineItems.map((item) => {
                        const image = item.variantImageUrl || item.imageUrl;

                        return (
                          <li
                            key={item.id}
                            className="flex items-center gap-3 text-sm"
                          >
                            <div className="h-12 w-12 rounded-lg bg-gray-100 overflow-hidden flex items-center justify-center">
                              {image ? (
                                <img
                                  src={image}
                                  alt={item.title}
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <Package className="w-5 h-5 text-gray-400" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-gray-900 font-medium truncate">
                                {item.title}
                              </p>
                              <p className="text-gray-700 text-xs">
                                {item.variantTitle || 'Default variant'}
                              </p>
                            </div>
                            <div className="flex items-center gap-3 text-xs text-gray-700">
                              <span>
                                {item.originalUnitPrice
                                  ? formatCurrency(
                                      item.originalUnitPrice,
                                      order.totalPriceCurrency
                                    )
                                  : '—'}
                              </span>
                              <span>x{item.quantity}</span>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>

                  <div className="p-3 border-b">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs text-gray-700 uppercase tracking-wide">
                        Shipping address
                      </p>
                      {editingAddress[order.id] ? (
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={savingAddressFor === order.id}
                            onClick={() =>
                              saveAddress(order.id, printify?.order.id)
                            }
                          >
                            <Save className="w-4 h-4 mr-1" />
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => cancelEditAddress(order.id)}
                          >
                            <X className="w-4 h-4 mr-1" />
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => startEditAddress(order, printify)}
                        >
                          <Pencil className="w-4 h-4 mr-1" />
                          Edit
                        </Button>
                      )}
                    </div>

                    {editingAddress[order.id] ? (
                      <div className="space-y-4">
                        <div className="rounded-lg border p-3">
                          <p className="text-xs font-semibold text-gray-700 mb-2">
                            Shopify
                          </p>
                          <div className="grid grid-cols-2 gap-2">
                            <Input
                              placeholder="First name"
                              value={addressEdits[order.id]?.firstName || ''}
                              onChange={(e) =>
                                setAddressEdits((prev) => ({
                                  ...prev,
                                  [order.id]: {
                                    ...prev[order.id],
                                    firstName: e.target.value,
                                  },
                                }))
                              }
                            />
                            <Input
                              placeholder="Last name"
                              value={addressEdits[order.id]?.lastName || ''}
                              onChange={(e) =>
                                setAddressEdits((prev) => ({
                                  ...prev,
                                  [order.id]: {
                                    ...prev[order.id],
                                    lastName: e.target.value,
                                  },
                                }))
                              }
                            />
                            <Input
                              className="col-span-2"
                              placeholder="Company"
                              value={addressEdits[order.id]?.company || ''}
                              onChange={(e) =>
                                setAddressEdits((prev) => ({
                                  ...prev,
                                  [order.id]: {
                                    ...prev[order.id],
                                    company: e.target.value,
                                  },
                                }))
                              }
                            />
                            <div className="col-span-2">
                              <AddressAutocomplete
                                placeholder="Address line 1"
                                value={addressEdits[order.id]?.address1 || ''}
                                onChange={(value) =>
                                  setAddressEdits((prev) => ({
                                    ...prev,
                                    [order.id]: {
                                      ...prev[order.id],
                                      address1: value,
                                    },
                                  }))
                                }
                                onSelect={(address: SelectedAddress) =>
                                  setAddressEdits((prev) => ({
                                    ...prev,
                                    [order.id]: {
                                      ...prev[order.id],
                                      address1: address.address1,
                                      address2: address.address2,
                                      city: address.city,
                                      province: address.province,
                                      provinceCode: address.provinceCode,
                                      zip: address.zip,
                                      country: address.country,
                                      countryCode: address.countryCode,
                                    },
                                  }))
                                }
                              />
                            </div>
                            <Input
                              className="col-span-2"
                              placeholder="Address line 2"
                              value={addressEdits[order.id]?.address2 || ''}
                              onChange={(e) =>
                                setAddressEdits((prev) => ({
                                  ...prev,
                                  [order.id]: {
                                    ...prev[order.id],
                                    address2: e.target.value,
                                  },
                                }))
                              }
                            />
                            <Input
                              placeholder="City"
                              value={addressEdits[order.id]?.city || ''}
                              onChange={(e) =>
                                setAddressEdits((prev) => ({
                                  ...prev,
                                  [order.id]: {
                                    ...prev[order.id],
                                    city: e.target.value,
                                  },
                                }))
                              }
                            />
                            <Input
                              placeholder="State"
                              value={addressEdits[order.id]?.province || ''}
                              onChange={(e) =>
                                setAddressEdits((prev) => ({
                                  ...prev,
                                  [order.id]: {
                                    ...prev[order.id],
                                    province: e.target.value,
                                  },
                                }))
                              }
                            />
                            <Input
                              placeholder="ZIP"
                              value={addressEdits[order.id]?.zip || ''}
                              onChange={(e) =>
                                setAddressEdits((prev) => ({
                                  ...prev,
                                  [order.id]: {
                                    ...prev[order.id],
                                    zip: e.target.value,
                                  },
                                }))
                              }
                            />
                            <Input
                              placeholder="Country"
                              value={addressEdits[order.id]?.country || ''}
                              onChange={(e) =>
                                setAddressEdits((prev) => ({
                                  ...prev,
                                  [order.id]: {
                                    ...prev[order.id],
                                    country: e.target.value,
                                  },
                                }))
                              }
                            />
                            <Input
                              className="col-span-2"
                              placeholder="Phone"
                              value={addressEdits[order.id]?.phone || ''}
                              onChange={(e) =>
                                setAddressEdits((prev) => ({
                                  ...prev,
                                  [order.id]: {
                                    ...prev[order.id],
                                    phone: e.target.value,
                                  },
                                }))
                              }
                            />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="grid gap-3">
                        <div className="rounded-lg border p-3">
                          <p className="text-xs font-semibold text-gray-700 mb-2">
                            Shopify
                          </p>
                          {order.shippingAddress ? (
                            <div className="text-sm text-gray-800 space-y-0.5">
                              {formatUsAddress(order.shippingAddress).map(
                                (line, idx) => (
                                  <div key={idx}>{line}</div>
                                )
                              )}
                            </div>
                          ) : (
                            <p className="text-sm text-gray-700">
                              No Shopify shipping address on file.
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {order.fulfillments.length > 0 && (
                    <div className="p-3 border-b">
                      <p className="text-xs text-gray-700 uppercase tracking-wide mb-2">
                        Shipping
                      </p>
                      {order.fulfillments.map((fulfillment) => (
                        <div
                          key={fulfillment.id}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Truck className="w-4 h-4 text-gray-500" />
                          <span className="flex-1 text-gray-900">
                            {fulfillment.trackingCompany || 'Tracking'}:{' '}
                            {fulfillment.trackingNumber || 'Pending'}
                          </span>
                          {fulfillment.trackingUrl && (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => {
                                  navigator.clipboard.writeText(fulfillment.trackingUrl!);
                                  setCopiedField(`tracking-${fulfillment.id}`);
                                  setTimeout(() => setCopiedField(null), 1200);
                                }}
                                className="p-1 text-gray-500 hover:text-gray-700 rounded hover:bg-gray-100"
                                title="Copy tracking URL"
                              >
                                {copiedField === `tracking-${fulfillment.id}` ? (
                                  <Check className="w-4 h-4 text-green-600" />
                                ) : (
                                  <Copy className="w-4 h-4" />
                                )}
                              </button>
                              <a
                                href={fulfillment.trackingUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-1 text-blue-700 hover:text-blue-800 rounded hover:bg-blue-50"
                                title="Open tracking page"
                              >
                                <ExternalLink className="w-4 h-4" />
                              </a>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {printify ? (
                    <div className="p-3 bg-purple-50">
                      <p className="text-xs text-purple-800 uppercase tracking-wide mb-2 flex items-center gap-1">
                        <Package className="w-3 h-3" />
                        Printify Production
                      </p>
                      <div className="flex items-center justify-between">
                        <Badge variant="info">{printify.productionStatus}</Badge>
                        <span className="text-xs text-gray-700">
                          Match: {Math.round(printify.matchConfidence * 100)}%
                        </span>
                      </div>
                      {/* Production & Transit Time Summary */}
                      {(() => {
                        const shipments = printify.order.shipments || [];
                        const uniqueShipments = Array.from(
                          new Map(shipments.map((s) => [`${s.carrier}-${s.number}`, s])).values()
                        );
                        const firstShipment = uniqueShipments[0];
                        const trackingKey = firstShipment ? `${firstShipment.carrier}-${firstShipment.number}` : '';
                        const tracking = trackingKey ? trackingData[trackingKey] : undefined;

                        // Get production date (earliest sent_to_production_at)
                        const productionDates = printify.order.line_items
                          .map((li) => li.sent_to_production_at)
                          .filter((d): d is string => !!d)
                          .map((d) => new Date(d));
                        const productionAt = productionDates.length > 0
                          ? new Date(Math.min(...productionDates.map((d) => d.getTime())))
                          : null;

                        // Get label created date from tracking
                        const labelCreatedAt = tracking?.data?.labelCreatedAt
                          ? new Date(tracking.data.labelCreatedAt)
                          : null;

                        // Get shipped date (carrier pickup)
                        const shippedDates = shipments
                          .map((s) => s.shipped_at)
                          .filter((d): d is string => !!d)
                          .map((d) => new Date(d));
                        const shippedAt = tracking?.data?.shippedAt
                          ? new Date(tracking.data.shippedAt)
                          : shippedDates.length > 0
                            ? new Date(Math.min(...shippedDates.map((d) => d.getTime())))
                            : null;

                        // Get delivered date
                        const deliveredDates = shipments
                          .map((s) => s.delivered_at)
                          .filter((d): d is string => !!d)
                          .map((d) => new Date(d));
                        const deliveredAt = tracking?.data?.deliveredAt
                          ? new Date(tracking.data.deliveredAt)
                          : deliveredDates.length > 0
                            ? new Date(Math.max(...deliveredDates.map((d) => d.getTime())))
                            : null;

                        const now = new Date();
                        const DELAY_THRESHOLD = 4; // days

                        // Production time (from sent_to_production to pickup)
                        const productionDays = productionAt && shippedAt
                          ? Math.ceil((shippedAt.getTime() - productionAt.getTime()) / (1000 * 60 * 60 * 24))
                          : null;
                        // Check if production is delayed (still in production for > 4 days)
                        const productionInProgress = productionAt && !shippedAt;
                        const productionWaitDays = productionInProgress
                          ? Math.ceil((now.getTime() - productionAt.getTime()) / (1000 * 60 * 60 * 24))
                          : null;
                        const productionDelayed = productionWaitDays !== null && productionWaitDays > DELAY_THRESHOLD;

                        // Pickup time (from label created to carrier pickup)
                        const pickupDays = labelCreatedAt && shippedAt
                          ? Math.ceil((shippedAt.getTime() - labelCreatedAt.getTime()) / (1000 * 60 * 60 * 24))
                          : null;
                        // Check if pickup is delayed (label created but not picked up for > 4 days)
                        const awaitingPickup = labelCreatedAt && !shippedAt;
                        const pickupWaitDays = awaitingPickup
                          ? Math.ceil((now.getTime() - labelCreatedAt.getTime()) / (1000 * 60 * 60 * 24))
                          : null;
                        const pickupDelayed = pickupWaitDays !== null && pickupWaitDays > DELAY_THRESHOLD;

                        // Transit time
                        const transitDays = shippedAt
                          ? deliveredAt
                            ? Math.ceil((deliveredAt.getTime() - shippedAt.getTime()) / (1000 * 60 * 60 * 24))
                            : Math.ceil((now.getTime() - shippedAt.getTime()) / (1000 * 60 * 60 * 24))
                          : null;

                        const hasContent = productionDays !== null || transitDays !== null || productionDelayed || pickupDelayed;
                        if (!hasContent) return null;

                        return (
                          <div className="mt-2 mb-3 flex flex-wrap gap-2 text-xs">
                            {/* Production completed */}
                            {productionDays !== null && (
                              <span className={cn(
                                "px-2 py-0.5 rounded",
                                productionDays > DELAY_THRESHOLD
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-gray-100 text-gray-700"
                              )}>
                                Production: {productionDays} {productionDays === 1 ? 'day' : 'days'}
                              </span>
                            )}
                            {/* Production in progress - delayed warning */}
                            {productionDelayed && productionWaitDays !== null && (
                              <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded">
                                Production delayed: {productionWaitDays} days
                              </span>
                            )}
                            {/* Pickup completed (only show if significantly delayed) */}
                            {pickupDays !== null && pickupDays > DELAY_THRESHOLD && (
                              <span className="bg-amber-100 text-amber-700 px-2 py-0.5 rounded">
                                Pickup wait: {pickupDays} {pickupDays === 1 ? 'day' : 'days'}
                              </span>
                            )}
                            {/* Awaiting pickup - delayed warning */}
                            {pickupDelayed && pickupWaitDays !== null && (
                              <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded">
                                Pickup delayed: {pickupWaitDays} days
                              </span>
                            )}
                            {/* Transit time */}
                            {transitDays !== null && (
                              <span className={cn(
                                "px-2 py-0.5 rounded",
                                deliveredAt
                                  ? "bg-green-100 text-green-700"
                                  : "bg-blue-100 text-blue-700"
                              )}>
                                {deliveredAt ? 'Delivered' : 'In transit'}: {transitDays} {transitDays === 1 ? 'day' : 'days'}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                      {/* Get Real Time Tracking buttons - above timeline */}
                      {printify.order.shipments?.length ? (
                        <div className="space-y-2 mb-3">
                          {Array.from(
                            new Map(
                              printify.order.shipments.map((s) => [`${s.carrier}-${s.number}`, s])
                            ).values()
                          ).map((shipment) => {
                            const trackingKey = `${shipment.carrier}-${shipment.number}`;
                            const tracking = trackingData[trackingKey];
                            const hasData = !!tracking?.data;
                            return (
                              <button
                                key={trackingKey}
                                onClick={() => fetchTrackingDetails(shipment.number, shipment.carrier, hasData)}
                                disabled={tracking?.loading}
                                className={cn(
                                  "w-full flex items-center justify-center gap-2 text-sm font-medium py-2.5 px-3 rounded-md transition-colors",
                                  hasData
                                    ? "bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200"
                                    : "bg-purple-600 text-white hover:bg-purple-700 shadow-sm",
                                  tracking?.loading && "opacity-70 cursor-wait"
                                )}
                              >
                                {tracking?.loading ? (
                                  <>
                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                    {hasData ? 'Refreshing...' : 'Loading...'}
                                  </>
                                ) : hasData ? (
                                  <>
                                    <RefreshCw className="w-4 h-4" />
                                    Refresh Tracking
                                    {tracking.cached && (
                                      <span className="text-xs text-purple-500">(cached)</span>
                                    )}
                                  </>
                                ) : (
                                  <>
                                    <Search className="w-4 h-4" />
                                    Get Real Time Tracking
                                  </>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}

                      {/* Shipping Timeline */}
                      {(() => {
                        if (!printify.order.created_at) return null;
                        const createdAt = new Date(printify.order.created_at);
                        const now = new Date();
                        const shipments = printify.order.shipments || [];

                        // Get tracking data from first shipment (deduplicated)
                        const uniqueShipments = Array.from(
                          new Map(shipments.map((s) => [`${s.carrier}-${s.number}`, s])).values()
                        );
                        const firstShipment = uniqueShipments[0];
                        const trackingKey = firstShipment ? `${firstShipment.carrier}-${firstShipment.number}` : '';
                        const tracking = trackingKey ? trackingData[trackingKey] : undefined;

                        // Get production date
                        const productionDates = printify.order.line_items
                          .map((li) => li.sent_to_production_at)
                          .filter((d): d is string => !!d)
                          .map((d) => new Date(d));
                        const productionAt = productionDates.length > 0
                          ? new Date(Math.min(...productionDates.map((d) => d.getTime())))
                          : null;

                        // Get fulfilled_at dates from line items (when label was created/item marked shipped)
                        const fulfilledDates = printify.order.line_items
                          .map((li) => (li as { fulfilled_at?: string }).fulfilled_at)
                          .filter((d): d is string => !!d)
                          .map((d) => new Date(d));
                        const fulfilledAt = fulfilledDates.length > 0
                          ? new Date(Math.min(...fulfilledDates.map((d) => d.getTime())))
                          : null;

                        // Get shipped and delivered dates from shipments
                        const shippedDates = shipments
                          .map((s) => s.shipped_at)
                          .filter((d): d is string => !!d)
                          .map((d) => new Date(d));
                        const deliveredDates = shipments
                          .map((s) => s.delivered_at)
                          .filter((d): d is string => !!d)
                          .map((d) => new Date(d));

                        // Use tracking data if available, otherwise use Printify data
                        const shippedAt = tracking?.data?.shippedAt
                          ? new Date(tracking.data.shippedAt)
                          : shippedDates.length > 0
                            ? new Date(Math.min(...shippedDates.map((d) => d.getTime())))
                            : null;
                        const deliveredAt = tracking?.data?.deliveredAt
                          ? new Date(tracking.data.deliveredAt)
                          : deliveredDates.length > 0
                            ? new Date(Math.max(...deliveredDates.map((d) => d.getTime())))
                            : null;

                        // Get milestone dates from tracking API
                        const carrierPickupAt = tracking?.data?.shippedAt
                          ? new Date(tracking.data.shippedAt)
                          : null;
                        const labelCreatedAt = tracking?.data?.labelCreatedAt
                          ? new Date(tracking.data.labelCreatedAt)
                          : null;

                        // Build tracking events for timeline
                        // Filter out events we show as separate milestones and events with empty descriptions
                        // Get milestone dates to avoid duplicates
                        const labelDateStr = labelCreatedAt?.toDateString();
                        const pickupDateStr = carrierPickupAt?.toDateString();

                        const trackingEvents = tracking?.data?.events
                          ?.filter((event) => {
                            const desc = (event.description || '').toLowerCase().trim();
                            // Must have a description
                            if (!desc) return false;
                            // Exclude events shown as milestones (shipping label created, pickup)
                            if (desc.includes('picked up') ||
                                desc.includes('shipment received') ||
                                desc.includes('origin scan') ||
                                desc.includes('shipping label') ||
                                desc.includes('label created') ||
                                desc.includes('electronic shipment') ||
                                desc.includes('pre-shipment') ||
                                desc.includes('info received') ||
                                desc.includes('information received') ||
                                desc.includes('awaiting item') ||
                                desc.includes('shipment information')) {
                              return false;
                            }
                            // Exclude events on same date as Pickup milestone (avoid "Picked Up" duplicate)
                            if (event.date && pickupDateStr) {
                              const eventDateStr = new Date(event.date).toDateString();
                              if (eventDateStr === pickupDateStr && desc.includes('pickup')) {
                                return false;
                              }
                            }
                            return true;
                          })
                          .map((event) => ({
                            label: event.description,
                            date: event.date ? new Date(event.date) : null,
                            location: event.location,
                            isTrackingEvent: true,
                            completed: true,
                          })) || [];

                        // Timeline steps - combine tracking events with milestones
                        const hasTrackingData = trackingEvents.length > 0 || carrierPickupAt || labelCreatedAt;

                        const unsortedSteps = hasTrackingData
                          ? [
                              // Tracking events
                              ...trackingEvents,
                              // Pickup milestone (from tracking API - carrier pickup date)
                              ...(carrierPickupAt ? [{
                                label: 'Pickup',
                                date: carrierPickupAt,
                                completed: true,
                              }] : []),
                              // Shipping label created milestone (from tracking API)
                              ...(labelCreatedAt ? [{
                                label: 'Shipping Label Created',
                                date: labelCreatedAt,
                                completed: true,
                              }] : []),
                              // In Production (from Printify)
                              ...(productionAt ? [{
                                label: 'In Production',
                                date: productionAt,
                                completed: true,
                              }] : []),
                              // Order Created at the bottom
                              {
                                label: 'Order Created',
                                date: createdAt,
                                completed: true,
                              },
                            ]
                          : [
                              // Fallback when no tracking data: use Printify milestones
                              // Only include milestones that have dates
                              ...(deliveredAt ? [{
                                label: 'Delivered',
                                date: deliveredAt,
                                completed: true,
                              }] : []),
                              ...(shippedAt ? [{
                                label: 'Shipped',
                                date: shippedAt,
                                completed: true,
                              }] : []),
                              // Fulfilled = label created in Printify (only show if no shippedAt to avoid redundancy)
                              ...(!shippedAt && fulfilledAt ? [{
                                label: 'Label Created',
                                date: fulfilledAt,
                                completed: true,
                              }] : []),
                              ...(productionAt ? [{
                                label: 'In Production',
                                date: productionAt,
                                completed: true,
                              }] : []),
                              {
                                label: 'Order Created',
                                date: createdAt,
                                completed: true,
                              },
                            ];

                        // Sort by date descending (newest first), Order Created always at bottom
                        const steps = unsortedSteps.sort((a, b) => {
                          // Order Created always goes last
                          if (a.label === 'Order Created') return 1;
                          if (b.label === 'Order Created') return -1;
                          // Sort by date descending (newest first)
                          if (!a.date) return 1;
                          if (!b.date) return -1;
                          return b.date.getTime() - a.date.getTime();
                        });

                        // Get estimated delivery from API - no fallback calculation
                        const estimatedDelivery = tracking?.data?.estimatedDelivery
                          ? new Date(tracking.data.estimatedDelivery).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                          : null;
                        const isDelivered = tracking?.data?.status === 'delivered' || !!deliveredAt;

                        // Current step index - find first uncompleted step (which is the "next" step in reverse order)
                        const currentStep = steps.findIndex(s => !s.completed);
                        const activeStep = currentStep === -1 ? 0 : currentStep;

                        return (
                          <div className="mt-3 border-t border-purple-200 pt-3">
                            {/* Estimated Delivery */}
                            {trackingEvents.length > 0 && !isDelivered && (
                              <div className="mb-3 p-2 bg-blue-50 rounded-lg">
                                <p className="text-xs text-blue-700">
                                  <span className="font-medium">Est. Delivery:</span>{' '}
                                  {estimatedDelivery || <span className="text-gray-500 italic">Not available</span>}
                                </p>
                              </div>
                            )}
                            <p className="text-xs text-purple-700 font-medium mb-2">Shipping Timeline</p>
                            <div className="relative">
                              {steps.map((step, idx) => {
                                const isLast = idx === steps.length - 1;
                                const isActive = idx === activeStep && !step.completed;
                                const isTrackingEvent = 'isTrackingEvent' in step && step.isTrackingEvent;

                                return (
                                  <div key={`${step.label}-${idx}`} className="flex items-start gap-2 relative">
                                    {/* Vertical line */}
                                    {!isLast && (
                                      <div
                                        className={cn(
                                          "absolute left-[7px] top-4 w-0.5 h-full",
                                          step.completed ? (isTrackingEvent ? "bg-blue-300" : "bg-purple-400") : "bg-gray-300"
                                        )}
                                      />
                                    )}
                                    {/* Circle - smaller for tracking events */}
                                    <div
                                      className={cn(
                                        "relative z-10 rounded-full border-2 flex-shrink-0",
                                        isTrackingEvent ? "w-2.5 h-2.5 mt-1" : "w-4 h-4 mt-0.5",
                                        step.completed
                                          ? isTrackingEvent ? "bg-blue-400 border-blue-400" : "bg-purple-500 border-purple-500"
                                          : isActive
                                            ? "bg-white border-purple-400 animate-pulse"
                                            : "bg-white border-gray-300"
                                      )}
                                    >
                                      {step.completed && !isTrackingEvent && (
                                        <Check className="w-2.5 h-2.5 text-white absolute top-0.5 left-0.5" />
                                      )}
                                    </div>
                                    {/* Content */}
                                    <div className={cn("pb-2 flex-1", isLast && "pb-0", isTrackingEvent && "pb-1.5")}>
                                      <p className={cn(
                                        "font-medium",
                                        isTrackingEvent ? "text-[10px] text-blue-700" : "text-xs",
                                        !isTrackingEvent && (step.completed ? "text-purple-800" : isActive ? "text-purple-600" : "text-gray-500")
                                      )}>
                                        {step.label}
                                      </p>
                                      {/* Location for tracking events */}
                                      {'location' in step && (step as { location?: string }).location ? (
                                        <p className="text-[10px] text-gray-400">{(step as { location: string }).location}</p>
                                      ) : null}
                                      {/* Subtitle (origin/destination) */}
                                      {'subtitle' in step && (step as { subtitle?: string }).subtitle && !isTrackingEvent ? (
                                        <p className="text-[10px] text-gray-500">{(step as { subtitle: string }).subtitle}</p>
                                      ) : null}
                                      {step.date && (
                                        <p className={cn("text-gray-500", isTrackingEvent ? "text-[10px]" : "text-xs")}>
                                          {step.date.toLocaleDateString('en-US', {
                                            month: 'short',
                                            day: 'numeric',
                                            year: step.date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
                                          })}
                                          {!isTrackingEvent && (
                                            <>
                                              {' '}
                                              {step.date.toLocaleTimeString('en-US', {
                                                hour: 'numeric',
                                                minute: '2-digit'
                                              })}
                                            </>
                                          )}
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>

                            {/* Tracking error */}
                            {tracking?.error && (
                              <div className="mt-2 text-xs text-red-600 bg-red-50 rounded px-2 py-1">
                                {tracking.error}
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      <button
                        onClick={() => setPrintifySupportOrderId(order.id)}
                        className="mt-3 w-full flex items-center justify-center gap-2 text-sm font-medium py-2 px-3 bg-orange-50 text-orange-700 hover:bg-orange-100 border border-orange-200 rounded-md transition-colors shadow-sm"
                      >
                        <MessageSquare className="w-4 h-4" />
                        Contact Printify Support
                      </button>
                    </div>
                  ) : (
                    <div className="p-3 bg-gray-50">
                      <p className="text-xs text-gray-700 uppercase tracking-wide mb-1">
                        Printify
                      </p>
                      <p className="text-sm text-gray-700">
                        No Printify match found for this order yet.
                      </p>
                    </div>
                  )}

                  {order.note && (
                    <div className="p-3 bg-yellow-50">
                      <p className="text-xs text-yellow-800 uppercase tracking-wide mb-1">
                        Note
                      </p>
                      <p className="text-sm text-yellow-900">{order.note}</p>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>
      )}

      {/* Reviews Tab Content */}
      {activeTab === 'reviews' && (
        <div className="p-4">
          <h3 className="font-semibold text-gray-900 mb-3">
            Product Reviews ({reviewsData?.totalCount || 0})
          </h3>
          {reviewsLoading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="w-5 h-5 text-gray-400 animate-spin" />
            </div>
          ) : !reviewsData?.reviews?.length ? (
            <div className="text-center py-8">
              <Star className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">No reviews found from this customer</p>
              <p className="text-xs text-gray-400 mt-1">Reviews will appear here when the customer leaves product reviews on Judge.me</p>
            </div>
          ) : (
            <div className="space-y-4">
              {reviewsData.reviews.map((review) => (
                <div key={review.id} className="border rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 text-sm truncate">
                        {review.product.title}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <div className="flex">
                          {[1, 2, 3, 4, 5].map((star) => (
                            <Star
                              key={star}
                              className={cn(
                                'w-3.5 h-3.5',
                                star <= review.rating
                                  ? 'text-yellow-400 fill-yellow-400'
                                  : 'text-gray-300'
                              )}
                            />
                          ))}
                        </div>
                        {review.verifiedPurchase && (
                          <span className="text-xs text-green-600 font-medium">
                            Verified
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="text-xs text-gray-500 whitespace-nowrap">
                      {new Date(review.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  {review.title && (
                    <p className="font-medium text-sm text-gray-800 mb-1">
                      {review.title}
                    </p>
                  )}
                  <p className="text-sm text-gray-600 whitespace-pre-wrap">
                    {review.body}
                  </p>
                  {review.pictureUrls && review.pictureUrls.length > 0 && (
                    <div className="flex gap-2 mt-2 overflow-x-auto">
                      {review.pictureUrls.map((url, i) => (
                        <img
                          key={i}
                          src={url}
                          alt={`Review photo ${i + 1}`}
                          className="w-16 h-16 object-cover rounded border"
                        />
                      ))}
                    </div>
                  )}
                  {review.replied && (
                    <div className="mt-2 pl-3 border-l-2 border-blue-200">
                      <p className="text-xs text-blue-600 font-medium">Store replied</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {replacementModalOrderId && replacementOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-5xl rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <div>
                <h4 className="text-lg font-semibold text-gray-900">
                  Replacement order for {replacementOrder.name}
                </h4>
              </div>
              <button
                onClick={() => setReplacementModalOrderId(null)}
                className="text-gray-500 hover:text-gray-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-5 py-3 max-h-[84vh] overflow-y-auto">
              <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="space-y-3">
                  <div className="rounded-xl border bg-white p-2">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-sm font-semibold text-gray-900">Products</p>
                    </div>
                    <div className="flex items-center gap-2 border rounded-lg px-3 py-2 bg-white">
                      <Search className="w-4 h-4 text-gray-500" />
                      <input
                        type="text"
                        placeholder="Search products"
                        value={replacementProductSearch}
                        onChange={(e) => setReplacementProductSearch(e.target.value)}
                        className="flex-1 text-sm text-gray-900 placeholder:text-gray-600 outline-none"
                      />
                      {replacementSearching && (
                        <RefreshCw className="w-4 h-4 text-gray-500 animate-spin" />
                      )}
                    </div>

                    {replacementSearchResults.length > 0 && (
                      <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border divide-y">
                        {replacementSearchResults.map((product) => {
                          const variantsForOptions =
                            variantOptions[product.id]?.variants?.length
                              ? variantOptions[product.id].variants
                              : product.variants;
                          const colorName = getSearchOptionName(
                            variantsForOptions,
                            'color'
                          );
                          const sizeName = getSearchOptionName(
                            variantsForOptions,
                            'size'
                          );
                          const colorOptions = getSearchOptionValues(
                            variantsForOptions,
                            colorName
                          );
                          const sizeOptions = getSearchOptionValues(
                            variantsForOptions,
                            sizeName
                          );
                          const selection = replacementSearchSelection[product.id] || {};
                          const selectedColor =
                            selection.color || colorOptions[0] || '';
                          const variantsForColor = colorName
                            ? variantsForOptions.filter(
                                (variantItem) =>
                                  getVariantOptionValue(variantItem, colorName) ===
                                  selectedColor
                              )
                            : variantsForOptions;
                          const sizeOptionsForColor = sizeName
                            ? getSearchOptionValues(variantsForColor, sizeName)
                            : sizeOptions;
                          const selectedSize =
                            selection.size ||
                            sizeOptionsForColor[0] ||
                            sizeOptions[0] ||
                            '';
                          const matchedVariant = findSearchVariant(
                            variantsForOptions,
                            colorName,
                            sizeName,
                            selectedColor,
                            selectedSize
                          );
                          const fallbackVariant =
                            matchedVariant ||
                            findSearchVariantByValues(
                              variantsForOptions,
                              selectedColor,
                              selectedSize
                            ) ||
                            findSearchVariantByTitle(
                              variantsForOptions,
                              selectedColor,
                              selectedSize
                            );
                          const variant =
                            (selection.variantId
                              ? variantsForOptions.find(
                                  (item) => item.id === selection.variantId
                                )
                              : undefined) ||
                            fallbackVariant ||
                            variantsForOptions[0];

                          return (
                            <div key={product.id} className="p-3">
                              <div className="flex items-center gap-3">
                                <div className="h-18 w-18 rounded-md bg-white border overflow-hidden flex items-center justify-center">
                                  {variant?.imageUrl || product.imageUrl ? (
                                    <img
                                      src={variant?.imageUrl || product.imageUrl}
                                      alt={product.title}
                                      className="h-full w-full object-cover"
                                    />
                                  ) : (
                                    <Package className="w-4 h-4 text-gray-400" />
                                  )}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium text-gray-900 truncate">
                                    {product.title}
                                  </p>
                                  <p className="text-xs text-gray-600">
                                    {variant?.title || 'Variant'}
                                  </p>
                                </div>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={async () => {
                                    const latestSelection =
                                      replacementSearchSelectionRef.current[product.id] || {};
                                    const latestColor =
                                      latestSelection.color || colorOptions[0] || '';
                                    let candidateVariants = variantsForOptions;
                                    let optionColorName = colorName;
                                    let optionSizeName = sizeName;
                                    const variantsForLatestColor = optionColorName
                                      ? candidateVariants.filter(
                                          (variantItem) =>
                                            getVariantOptionValue(
                                              variantItem,
                                              optionColorName
                                            ) === latestColor
                                        )
                                      : candidateVariants;
                                    const sizeOptionsForLatestColor = optionSizeName
                                      ? getSearchOptionValues(
                                          variantsForLatestColor,
                                          optionSizeName
                                        )
                                      : sizeOptions;
                                    const latestSize =
                                      latestSelection.size ||
                                      sizeOptionsForLatestColor[0] ||
                                      sizeOptions[0] ||
                                      '';

                                    let latestVariant =
                                      (latestSelection.variantId
                                        ? candidateVariants.find(
                                            (item) => item.id === latestSelection.variantId
                                          )
                                        : undefined) ||
                                      findSearchVariant(
                                        candidateVariants,
                                        optionColorName,
                                        optionSizeName,
                                        latestColor,
                                        latestSize
                                      ) ||
                                      findSearchVariantByValues(
                                        candidateVariants,
                                        latestColor,
                                        latestSize
                                      ) ||
                                      findSearchVariantByTitle(
                                        candidateVariants,
                                        latestColor,
                                        latestSize
                                      );

                                    if (
                                      !latestVariant &&
                                      product.id &&
                                      !variantOptions[product.id]
                                    ) {
                                      const loaded = await loadVariantsForProduct(product.id);
                                      if (loaded?.variants?.length) {
                                        candidateVariants = loaded.variants;
                                        optionColorName = getSearchOptionName(
                                          candidateVariants,
                                          'color'
                                        );
                                        optionSizeName = getSearchOptionName(
                                          candidateVariants,
                                          'size'
                                        );
                                        const variantsForLoadedColor = optionColorName
                                          ? candidateVariants.filter(
                                              (variantItem) =>
                                                getVariantOptionValue(
                                                  variantItem,
                                                  optionColorName
                                                ) === latestColor
                                            )
                                          : candidateVariants;
                                        const sizeOptionsForLoadedColor =
                                          optionSizeName
                                            ? getSearchOptionValues(
                                                variantsForLoadedColor,
                                                optionSizeName
                                              )
                                            : sizeOptions;
                                        const resolvedSize =
                                          latestSelection.size ||
                                          sizeOptionsForLoadedColor[0] ||
                                          sizeOptions[0] ||
                                          '';
                                        latestVariant =
                                          (latestSelection.variantId
                                            ? candidateVariants.find(
                                                (item) =>
                                                  item.id === latestSelection.variantId
                                              )
                                            : undefined) ||
                                          findSearchVariant(
                                            candidateVariants,
                                            optionColorName,
                                            optionSizeName,
                                            latestColor,
                                            resolvedSize
                                          ) ||
                                          findSearchVariantByValues(
                                            candidateVariants,
                                            latestColor,
                                            resolvedSize
                                          ) ||
                                          findSearchVariantByTitle(
                                            candidateVariants,
                                            latestColor,
                                            resolvedSize
                                          );
                                      }
                                    }

                                    const fallbackVariant =
                                      latestVariant || candidateVariants[0];

                                    if (fallbackVariant) {
                                      addReplacementItem(
                                        replacementOrder.id,
                                        product,
                                        fallbackVariant
                                      );
                                    }
                                  }}
                                >
                                  Add
                                </Button>
                              </div>

                              <div className="mt-2 grid grid-cols-2 gap-2">
                                {colorName && colorOptions.length > 0 && (
                                  <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-gray-500">
                                      Color
                                    </label>
                                    <select
                                    className="w-full border rounded px-2 py-1 text-xs text-gray-900 bg-white"
                                    value={selectedColor}
                                    onChange={(e) =>
                                      (() => {
                                        const nextColor = e.target.value;
                                        const nextVariantsForColor = colorName
                                          ? variantsForOptions.filter(
                                              (variantItem) =>
                                                getVariantOptionValue(
                                                  variantItem,
                                                  colorName
                                                ) === nextColor
                                            )
                                          : variantsForOptions;
                                        const nextSizeOptions = sizeName
                                          ? getSearchOptionValues(
                                              nextVariantsForColor,
                                              sizeName
                                            )
                                          : sizeOptions;
                                        const currentSizeSelection =
                                          replacementSearchSelectionRef.current[product.id]
                                            ?.size;
                                        const nextSize =
                                          currentSizeSelection &&
                                          nextSizeOptions.includes(currentSizeSelection)
                                            ? currentSizeSelection
                                            : nextSizeOptions[0] || '';
                                        const nextVariant =
                                          findSearchVariant(
                                            variantsForOptions,
                                            colorName,
                                            sizeName,
                                              nextColor,
                                              nextSize
                                            ) ||
                                            findSearchVariantByValues(
                                              variantsForOptions,
                                              nextColor,
                                              nextSize
                                            ) ||
                                            findSearchVariantByTitle(
                                              variantsForOptions,
                                              nextColor,
                                              nextSize
                                            );
                                        updateReplacementSearchSelection(product.id, {
                                          color: nextColor,
                                          size: nextSize,
                                          variantId: nextVariant?.id,
                                        });
                                      })()
                                    }
                                  >
                                      {colorOptions.map((value) => (
                                        <option key={value} value={value}>
                                          {value}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                                {sizeName && sizeOptionsForColor.length > 0 && (
                                  <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-gray-500">
                                      Size
                                    </label>
                                    <select
                                    className="w-full border rounded px-2 py-1 text-xs text-gray-900 bg-white"
                                    value={selectedSize}
                                    onChange={(e) =>
                                      (() => {
                                        const nextSize = e.target.value;
                                        const nextColor =
                                          replacementSearchSelectionRef.current[product.id]
                                            ?.color || selectedColor;
                                        const nextVariant =
                                            findSearchVariant(
                                              variantsForOptions,
                                              colorName,
                                              sizeName,
                                              nextColor,
                                              nextSize
                                            ) ||
                                            findSearchVariantByValues(
                                              variantsForOptions,
                                              nextColor,
                                              nextSize
                                            ) ||
                                            findSearchVariantByTitle(
                                              variantsForOptions,
                                              nextColor,
                                              nextSize
                                            );
                                        updateReplacementSearchSelection(product.id, {
                                          color: nextColor,
                                          size: nextSize,
                                          variantId: nextVariant?.id,
                                        });
                                      })()
                                    }
                                  >
                                      {sizeOptionsForColor.map((value) => (
                                        <option key={value} value={value}>
                                          {value}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                                {(!colorName || !sizeName) && (
                                  <div className="col-span-2 flex flex-col gap-1">
                                    <label className="text-[11px] font-medium text-gray-500">
                                      Variant
                                    </label>
                                    <select
                                      className="w-full border rounded px-2 py-1 text-sm text-gray-900 bg-white"
                                    value={selection.variantId || variant?.id || ''}
                                    onChange={(e) =>
                                      updateReplacementSearchSelection(product.id, {
                                        variantId: e.target.value,
                                      })
                                    }
                                  >
                                      {variantsForOptions.map((v) => (
                                        <option key={v.id} value={v.id}>
                                          {v.title}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="mt-4 overflow-hidden rounded-lg border">
                      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_auto] gap-3 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-600">
                        <span>Product</span>
                        <span>Variant</span>
                        <span>Qty</span>
                        <span>Total</span>
                        <span></span>
                      </div>
                      {(replacementItems[replacementOrder.id] || []).map((item) => {
                        const productId = item.productId;
                        const options = productId ? variantOptions[productId] : null;
                        const loading = productId ? loadingVariants[productId] : false;
                        const variants = options?.variants || [];
                        const currentVariant = variants.find(
                          (variant) => variant.id === item.variantId
                        );
                        // Get color/size option names - fallback to item's stored options
                        const colorName = getOptionName(variants, 'color') ||
                          item.selectedOptions?.find((opt) =>
                            opt.name.toLowerCase().includes('color')
                          )?.name || null;
                        const sizeName = getOptionName(variants, 'size') ||
                          item.selectedOptions?.find((opt) =>
                            opt.name.toLowerCase().includes('size')
                          )?.name || null;
                        const currentColor =
                          item.selectedOptions?.find((opt) => opt.name === colorName)
                            ?.value ||
                          getVariantOptionValue(currentVariant, colorName);
                        const currentSize =
                          item.selectedOptions?.find((opt) => opt.name === sizeName)
                            ?.value ||
                          getVariantOptionValue(currentVariant, sizeName);
                        const colorOptions = getOptionValues(variants, colorName);
                        const sizeOptions = getOptionValues(variants, sizeName);

                        const updateVariantFromOptions = (
                          nextColor: string | null,
                          nextSize: string | null
                        ) => {
                          if (!variants.length) return;
                          const match = variants.find((variant) => {
                            const selected = variant.selectedOptions || [];
                            const colorMatch = colorName
                              ? selected.some(
                                  (opt) =>
                                    opt.name === colorName && opt.value === nextColor
                                )
                              : true;
                            const sizeMatch = sizeName
                              ? selected.some(
                                  (opt) =>
                                    opt.name === sizeName && opt.value === nextSize
                                )
                              : true;
                            return colorMatch && sizeMatch;
                          });

                          if (match) {
                            updateReplacementItem(replacementOrder.id, item.id, {
                              variantId: match.id,
                              variantTitle: match.title,
                              selectedOptions: match.selectedOptions,
                              price: match.price,
                              sku: match.sku,
                              imageUrl: match.imageUrl || item.imageUrl,
                            });
                          }
                        };

                        const unitPrice = parseFloat(item.price || '0');
                        const lineTotal = unitPrice * item.quantity;

                        return (
                          <div
                            key={item.id}
                            className="grid grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_auto] gap-3 px-3 py-3 border-t text-sm"
                          >
                            <div className="flex items-center gap-3">
                              <div className="h-12 w-12 rounded-md bg-gray-100 overflow-hidden flex items-center justify-center">
                                {item.imageUrl ? (
                                  <img
                                    src={item.imageUrl}
                                    alt={item.title}
                                    className="h-full w-full object-cover"
                                  />
                                ) : (
                                  <Package className="w-5 h-5 text-gray-400" />
                                )}
                              </div>
                              <div>
                                <p className="font-medium text-gray-900">
                                  {item.title}
                                </p>
                                <p className="text-xs text-gray-600">
                                  ${unitPrice.toFixed(2)} each
                                </p>
                              </div>
                            </div>
                            <div className="space-y-2">
                              {loading ? (
                                <p className="text-xs text-gray-500 italic">Loading variants...</p>
                              ) : colorName && colorOptions.length > 0 ? (
                                <>
                                  <select
                                    className="w-full border rounded px-2 py-1 text-xs text-gray-900 bg-white"
                                    value={currentColor || ''}
                                    onChange={(e) => {
                                      const nextColor = e.target.value;
                                      updateVariantFromOptions(nextColor, currentSize || null);
                                    }}
                                  >
                                    {colorOptions.map((value) => (
                                      <option key={value} value={value}>
                                        {value}
                                      </option>
                                    ))}
                                  </select>
                                  {sizeName && sizeOptions.length > 0 && (
                                    <select
                                      className="w-full border rounded px-2 py-1 text-xs text-gray-900 bg-white"
                                      value={currentSize || ''}
                                      onChange={(e) => {
                                        const nextSize = e.target.value;
                                        updateVariantFromOptions(currentColor || null, nextSize);
                                      }}
                                    >
                                      {sizeOptions.map((value) => (
                                        <option key={value} value={value}>
                                          {value}
                                        </option>
                                      ))}
                                    </select>
                                  )}
                                </>
                              ) : sizeName && sizeOptions.length > 0 ? (
                                <select
                                  className="w-full border rounded px-2 py-1 text-xs text-gray-900 bg-white"
                                  value={currentSize || ''}
                                  onChange={(e) => {
                                    const nextSize = e.target.value;
                                    updateVariantFromOptions(currentColor || null, nextSize);
                                  }}
                                >
                                  {sizeOptions.map((value) => (
                                    <option key={value} value={value}>
                                      {value}
                                    </option>
                                  ))}
                                </select>
                              ) : variants.length > 0 ? (
                                <select
                                  className="w-full border rounded px-2 py-1 text-xs text-gray-900 bg-white"
                                  value={item.variantId}
                                  onChange={(e) => {
                                    const nextId = e.target.value;
                                    const next = variants.find(
                                      (variant) => variant.id === nextId
                                    );
                                    updateReplacementItem(replacementOrder.id, item.id, {
                                      variantId: nextId,
                                      variantTitle: next?.title || item.variantTitle,
                                      selectedOptions:
                                        next?.selectedOptions || item.selectedOptions,
                                      price: next?.price || item.price,
                                      sku: next?.sku || item.sku,
                                    });
                                  }}
                                >
                                  {variants.map((variant) => (
                                    <option key={variant.id} value={variant.id}>
                                      {variant.title}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <p className="text-xs text-gray-600 truncate">
                                  {item.variantTitle}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center">
                              <div className="relative inline-flex items-center rounded border bg-white overflow-hidden">
                                <input
                                  type="number"
                                  min="1"
                                  value={item.quantity}
                                  onChange={(e) =>
                                    updateReplacementItem(replacementOrder.id, item.id, {
                                      quantity: Math.max(
                                        1,
                                        parseInt(e.target.value || '1', 10)
                                      ),
                                    })
                                  }
                                  className="w-12 pr-6 text-center text-sm text-gray-900 bg-white outline-none appearance-none"
                                />
                                <div className="absolute right-0 top-0 bottom-0 flex flex-col border-l">
                                  <button
                                    className="flex-1 px-1 text-gray-600 hover:bg-gray-50"
                                    onClick={() =>
                                      updateReplacementItem(replacementOrder.id, item.id, {
                                        quantity: item.quantity + 1,
                                      })
                                    }
                                    aria-label="Increase quantity"
                                  >
                                    <ChevronUp className="w-3 h-3" />
                                  </button>
                                  <button
                                    className="flex-1 px-1 text-gray-600 hover:bg-gray-50"
                                    onClick={() =>
                                      updateReplacementItem(replacementOrder.id, item.id, {
                                        quantity: Math.max(1, item.quantity - 1),
                                      })
                                    }
                                    aria-label="Decrease quantity"
                                  >
                                    <ChevronDown className="w-3 h-3" />
                                  </button>
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center font-medium text-gray-900">
                              ${lineTotal.toFixed(2)}
                            </div>
                            <button
                              className="text-gray-400 hover:text-gray-600"
                              onClick={() =>
                                removeReplacementItem(replacementOrder.id, item.id)
                              }
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="rounded-xl border bg-white p-2">
                    <p className="text-sm font-semibold text-gray-900 mb-3">
                      Payment summary
                    </p>
                    {(() => {
                      const items = replacementItems[replacementOrder.id] || [];
                      const subtotal = items.reduce((sum, item) => {
                        const price = parseFloat(item.price || '0');
                        return sum + price * item.quantity;
                      }, 0);
                      const discountType =
                        replacementDiscountType[replacementOrder.id] || 'PERCENTAGE';
                      const discountValueRaw = parseFloat(
                        replacementDiscountValue[replacementOrder.id] || '0'
                      );
                      const discountBase =
                        discountType === 'PERCENTAGE'
                          ? subtotal * (discountValueRaw / 100)
                          : discountValueRaw;
                      const discount = Math.min(Math.max(discountBase, 0), subtotal);
                      const shippingRateSelection =
                        replacementShippingRateSelection[replacementOrder.id] || '';
                      const shippingRate =
                        (replacementShippingRates[replacementOrder.id] || []).find(
                          (rate) => rate.id === shippingRateSelection
                        ) || null;
                      const shipping = shippingRate
                        ? parseFloat(shippingRate.price || '0')
                        : 0;
                      const taxExempt =
                        replacementTaxExempt[replacementOrder.id] ?? true;
                      const tax = taxExempt ? 0 : 0;
                      const total = Math.max(subtotal - discount + shipping + tax, 0);

                      return (
                        <div className="space-y-3 text-sm text-gray-700">
                          <div className="flex items-center justify-between">
                            <span>Subtotal</span>
                            <span>${subtotal.toFixed(2)}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="shrink-0">Discount</span>
                            <Input
                              placeholder="Reason"
                              value={
                                replacementReasons[replacementOrder.id] ?? 'Size exchange'
                              }
                              onChange={(e) =>
                                setReplacementReasons((prev) => ({
                                  ...prev,
                                  [replacementOrder.id]: e.target.value,
                                }))
                              }
                              className="w-36 placeholder:text-gray-600"
                            />
                            <select
                              className="w-16 border rounded px-2 py-1 text-xs text-gray-900 bg-white"
                              value={
                                replacementDiscountType[replacementOrder.id] ||
                                'PERCENTAGE'
                              }
                              onChange={(e) =>
                                setReplacementDiscountType((prev) => ({
                                  ...prev,
                                  [replacementOrder.id]: e.target.value as
                                    | 'PERCENTAGE'
                                    | 'FIXED_AMOUNT',
                                }))
                              }
                            >
                              <option value="PERCENTAGE">%</option>
                              <option value="FIXED_AMOUNT">$</option>
                            </select>
                            <input
                              type="number"
                              min="0"
                              value={replacementDiscountValue[replacementOrder.id] ?? '0'}
                              onChange={(e) =>
                                setReplacementDiscountValue((prev) => ({
                                  ...prev,
                                  [replacementOrder.id]: e.target.value,
                                }))
                              }
                              className="w-16 border rounded px-2 py-1 text-xs text-gray-900 bg-white"
                            />
                            <span className="ml-auto shrink-0">
                              - ${discount.toFixed(2)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 w-full">
                              <span className="shrink-0">Shipping</span>
                            <select
                              className="w-auto border rounded px-2 py-1 text-sm text-gray-900 bg-white"
                              value={
                                replacementShippingRateSelection[replacementOrder.id] ||
                                ''
                              }
                              onChange={(e) =>
                                setReplacementShippingRateSelection((prev) => ({
                                  ...prev,
                                  [replacementOrder.id]: e.target.value,
                                }))
                              }
                            >
                              <option value="">No shipping</option>
                              {(replacementShippingRates[replacementOrder.id] || []).map(
                                (rate) => (
                                  <option key={rate.id} value={rate.id}>
                                    {rate.title} — ${parseFloat(rate.price).toFixed(2)}
                                  </option>
                                )
                              )}
                            </select>
                            {replacementShippingRatesLoading[replacementOrder.id] && (
                              <RefreshCw className="w-4 h-4 text-gray-500 animate-spin" />
                            )}
                            </div>
                            <span className="shrink-0">${shipping.toFixed(2)}</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span>Tax</span>
                            <span>${tax.toFixed(2)}</span>
                          </div>
                          <label className="flex items-center gap-2 text-xs text-gray-600">
                            <input
                              type="checkbox"
                              checked={taxExempt}
                              onChange={(e) =>
                                setReplacementTaxExempt((prev) => ({
                                  ...prev,
                                  [replacementOrder.id]: e.target.checked,
                                }))
                              }
                            />
                            Tax exempt
                          </label>
                          <div className="flex items-center justify-between font-medium text-gray-900 pt-2 border-t">
                            <span>Total</span>
                            <span>${total.toFixed(2)}</span>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>

                <div className="space-y-2 text-[13px]">
                  <div className="rounded-xl border bg-white p-2">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-sm font-semibold text-gray-900">Customer</p>
                      <button
                        className="text-xs text-blue-700 hover:underline"
                        onClick={() =>
                          setShowCustomerSearch((prev) => ({
                            ...prev,
                            [replacementOrder.id]: !prev[replacementOrder.id],
                          }))
                        }
                      >
                        {showCustomerSearch[replacementOrder.id]
                          ? 'Hide'
                          : 'Change'}
                      </button>
                    </div>
                    {(() => {
                      const selected =
                        replacementSelectedCustomer[replacementOrder.id] ||
                        customer ||
                        null;

                      return (
                        <>
                          <p className="text-sm font-medium text-gray-900">
                            {selected?.displayName || fallbackName || 'Unknown'}
                          </p>
                          <p className="text-xs text-gray-700">
                            {selected?.email || fallbackEmail || 'No email'}
                          </p>
                        </>
                      );
                    })()}

                    <div className="mt-3">
                      <button
                        className="text-xs text-blue-700 hover:underline"
                        onClick={() =>
                          setShowCustomerSearch((prev) => ({
                            ...prev,
                            [replacementOrder.id]: !prev[replacementOrder.id],
                          }))
                        }
                      >
                        {showCustomerSearch[replacementOrder.id]
                          ? 'Hide search'
                          : 'Search customers'}
                      </button>
                    </div>

                    {showCustomerSearch[replacementOrder.id] && (
                      <div className="mt-3">
                        <div className="flex items-center gap-2 border rounded-lg px-2 py-1.5 bg-white">
                          <Search className="w-4 h-4 text-gray-500" />
                          <input
                            type="text"
                            placeholder="Search by name or email"
                            value={replacementCustomerSearch}
                            onChange={(e) =>
                              setReplacementCustomerSearch(e.target.value)
                            }
                            className="flex-1 text-xs text-gray-900 placeholder:text-gray-600 outline-none"
                          />
                          {replacementCustomerSearching && (
                            <RefreshCw className="w-4 h-4 text-gray-500 animate-spin" />
                          )}
                        </div>

                        {replacementCustomerResults.length > 0 && (
                          <div className="mt-2 rounded-lg border max-h-40 overflow-y-auto">
                            {replacementCustomerResults.map((cust) => (
                              <button
                                key={cust.id || cust.email}
                                onClick={() => {
                                  setReplacementSelectedCustomer((prev) => ({
                                    ...prev,
                                    [replacementOrder.id]: cust,
                                  }));
                                  setShowCustomerSearch((prev) => ({
                                    ...prev,
                                    [replacementOrder.id]: false,
                                  }));
                                  setReplacementCustomerSearch('');
                                  setReplacementCustomerResults([]);
                                }}
                                className="w-full text-left px-3 py-2 text-xs hover:bg-blue-50"
                              >
                                <p className="font-medium text-gray-900">
                                  {cust.displayName || cust.email}
                                </p>
                                <p className="text-xs text-gray-600">
                                  {cust.email}
                                </p>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border bg-white p-2">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-sm font-semibold text-gray-900">Shipping</p>
                      <button
                        className="text-xs text-blue-700 hover:underline"
                        onClick={() =>
                          setEditingShipping((prev) => ({
                            ...prev,
                            [replacementOrder.id]: !prev[replacementOrder.id],
                          }))
                        }
                      >
                        {editingShipping[replacementOrder.id] ? 'Done' : 'Edit'}
                      </button>
                    </div>
                    {editingShipping[replacementOrder.id] ? (
                      <div className="grid grid-cols-2 gap-2">
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-gray-500">First name</label>
                          <Input
                            placeholder="First name"
                            value={
                              replacementShippingAddress[replacementOrder.id]?.firstName ||
                              ''
                            }
                            onChange={(e) =>
                              setReplacementShippingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  firstName: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-gray-500">Last name</label>
                          <Input
                            placeholder="Last name"
                            value={
                              replacementShippingAddress[replacementOrder.id]?.lastName ||
                              ''
                            }
                            onChange={(e) =>
                              setReplacementShippingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  lastName: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                        <div className="col-span-2 flex flex-col gap-1">
                          <label className="text-xs text-gray-500">Company</label>
                          <Input
                            placeholder="Company"
                            value={
                              replacementShippingAddress[replacementOrder.id]?.company ||
                              ''
                            }
                            onChange={(e) =>
                              setReplacementShippingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  company: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                        <div className="col-span-2 flex flex-col gap-1">
                          <label className="text-xs text-gray-500">Address 1</label>
                          <Input
                            placeholder="Address 1"
                            value={
                              replacementShippingAddress[replacementOrder.id]?.address1 ||
                              ''
                            }
                            onChange={(e) =>
                              setReplacementShippingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  address1: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                        <div className="col-span-2 flex flex-col gap-1">
                          <label className="text-xs text-gray-500">Address 2</label>
                          <Input
                            placeholder="Address 2"
                            value={
                              replacementShippingAddress[replacementOrder.id]?.address2 ||
                              ''
                            }
                            onChange={(e) =>
                              setReplacementShippingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  address2: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-gray-500">City</label>
                          <Input
                            placeholder="City"
                            value={
                              replacementShippingAddress[replacementOrder.id]?.city || ''
                            }
                            onChange={(e) =>
                              setReplacementShippingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  city: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-gray-500">State</label>
                          <Input
                            placeholder="State"
                            value={
                              replacementShippingAddress[replacementOrder.id]?.province ||
                              ''
                            }
                            onChange={(e) =>
                              setReplacementShippingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  province: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-gray-500">ZIP</label>
                          <Input
                            placeholder="ZIP"
                            value={
                              replacementShippingAddress[replacementOrder.id]?.zip || ''
                            }
                            onChange={(e) =>
                              setReplacementShippingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  zip: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-gray-500">Country</label>
                          <Input
                            placeholder="Country"
                            value={
                              replacementShippingAddress[replacementOrder.id]?.country ||
                              ''
                            }
                            onChange={(e) =>
                              setReplacementShippingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  country: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                        <div className="col-span-2 flex flex-col gap-1">
                          <label className="text-xs text-gray-500">Phone</label>
                          <Input
                            placeholder="Phone"
                            value={
                              replacementShippingAddress[replacementOrder.id]?.phone ||
                              ''
                            }
                            onChange={(e) =>
                              setReplacementShippingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  phone: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-gray-700">
                        {replacementShippingAddress[replacementOrder.id]
                          ? [
                              replacementShippingAddress[replacementOrder.id]?.name ||
                                [
                                  replacementShippingAddress[replacementOrder.id]
                                    ?.firstName,
                                  replacementShippingAddress[replacementOrder.id]
                                    ?.lastName,
                                ]
                                  .filter(Boolean)
                                  .join(' '),
                              replacementShippingAddress[replacementOrder.id]?.company,
                              replacementShippingAddress[replacementOrder.id]?.address1,
                              replacementShippingAddress[replacementOrder.id]?.address2,
                              replacementShippingAddress[replacementOrder.id]?.city,
                              replacementShippingAddress[replacementOrder.id]?.province ||
                                replacementShippingAddress[replacementOrder.id]
                                  ?.provinceCode,
                              replacementShippingAddress[replacementOrder.id]?.zip,
                              replacementShippingAddress[replacementOrder.id]?.country ||
                                replacementShippingAddress[replacementOrder.id]
                                  ?.countryCode,
                              replacementShippingAddress[replacementOrder.id]?.phone,
                            ]
                              .filter(Boolean)
                              .join(', ')
                          : 'No shipping address'}
                      </p>
                    )}
                  </div>

                  <div className="rounded-xl border bg-white p-2">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-sm font-semibold text-gray-900">Billing</p>
                      <button
                        className="text-xs text-blue-700 hover:underline"
                        onClick={() =>
                          setEditingBilling((prev) => ({
                            ...prev,
                            [replacementOrder.id]: !prev[replacementOrder.id],
                          }))
                        }
                      >
                        {editingBilling[replacementOrder.id] ? 'Done' : 'Edit'}
                      </button>
                    </div>
                    {editingBilling[replacementOrder.id] ? (
                      <div className="grid grid-cols-2 gap-2">
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-gray-500">First name</label>
                          <Input
                            placeholder="First name"
                            value={
                              replacementBillingAddress[replacementOrder.id]?.firstName ||
                              ''
                            }
                            onChange={(e) =>
                              setReplacementBillingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  firstName: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-gray-500">Last name</label>
                          <Input
                            placeholder="Last name"
                            value={
                              replacementBillingAddress[replacementOrder.id]?.lastName ||
                              ''
                            }
                            onChange={(e) =>
                              setReplacementBillingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  lastName: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                        <div className="col-span-2 flex flex-col gap-1">
                          <label className="text-xs text-gray-500">Company</label>
                          <Input
                            placeholder="Company"
                            value={
                              replacementBillingAddress[replacementOrder.id]?.company ||
                              ''
                            }
                            onChange={(e) =>
                              setReplacementBillingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  company: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                        <div className="col-span-2 flex flex-col gap-1">
                          <label className="text-xs text-gray-500">Address 1</label>
                          <Input
                            placeholder="Address 1"
                            value={
                              replacementBillingAddress[replacementOrder.id]?.address1 ||
                              ''
                            }
                            onChange={(e) =>
                              setReplacementBillingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  address1: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                        <div className="col-span-2 flex flex-col gap-1">
                          <label className="text-xs text-gray-500">Address 2</label>
                          <Input
                            placeholder="Address 2"
                            value={
                              replacementBillingAddress[replacementOrder.id]?.address2 ||
                              ''
                            }
                            onChange={(e) =>
                              setReplacementBillingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  address2: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-gray-500">City</label>
                          <Input
                            placeholder="City"
                            value={
                              replacementBillingAddress[replacementOrder.id]?.city || ''
                            }
                            onChange={(e) =>
                              setReplacementBillingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  city: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-gray-500">State</label>
                          <Input
                            placeholder="State"
                            value={
                              replacementBillingAddress[replacementOrder.id]?.province ||
                              ''
                            }
                            onChange={(e) =>
                              setReplacementBillingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  province: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-gray-500">ZIP</label>
                          <Input
                            placeholder="ZIP"
                            value={
                              replacementBillingAddress[replacementOrder.id]?.zip || ''
                            }
                            onChange={(e) =>
                              setReplacementBillingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  zip: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-xs text-gray-500">Country</label>
                          <Input
                            placeholder="Country"
                            value={
                              replacementBillingAddress[replacementOrder.id]?.country ||
                              ''
                            }
                            onChange={(e) =>
                              setReplacementBillingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  country: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                        <div className="col-span-2 flex flex-col gap-1">
                          <label className="text-xs text-gray-500">Phone</label>
                          <Input
                            placeholder="Phone"
                            value={
                              replacementBillingAddress[replacementOrder.id]?.phone ||
                              ''
                            }
                            onChange={(e) =>
                              setReplacementBillingAddress((prev) => ({
                                ...prev,
                                [replacementOrder.id]: {
                                  ...prev[replacementOrder.id],
                                  phone: e.target.value,
                                },
                              }))
                            }
                            className="placeholder:text-gray-600"
                          />
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-gray-700">
                        {replacementBillingAddress[replacementOrder.id]
                          ? [
                              replacementBillingAddress[replacementOrder.id]?.name ||
                                [
                                  replacementBillingAddress[replacementOrder.id]
                                    ?.firstName,
                                  replacementBillingAddress[replacementOrder.id]
                                    ?.lastName,
                                ]
                                  .filter(Boolean)
                                  .join(' '),
                              replacementBillingAddress[replacementOrder.id]?.company,
                              replacementBillingAddress[replacementOrder.id]?.address1,
                              replacementBillingAddress[replacementOrder.id]?.address2,
                              replacementBillingAddress[replacementOrder.id]?.city,
                              replacementBillingAddress[replacementOrder.id]?.province ||
                                replacementBillingAddress[replacementOrder.id]
                                  ?.provinceCode,
                              replacementBillingAddress[replacementOrder.id]?.zip,
                              replacementBillingAddress[replacementOrder.id]?.country ||
                                replacementBillingAddress[replacementOrder.id]
                                  ?.countryCode,
                              replacementBillingAddress[replacementOrder.id]?.phone,
                            ]
                              .filter(Boolean)
                              .join(', ')
                          : 'No billing address'}
                      </p>
                    )}
                  </div>

                  <div className="rounded-xl border bg-white p-2">
                    <p className="text-sm font-semibold text-gray-900 mb-1">Tags</p>
                    <Input
                      placeholder="Add tags"
                      value={replacementTags[replacementOrder.id] || ''}
                      onChange={(e) => {
                        const value = e.target.value;
                        setReplacementTags((prev) => ({
                          ...prev,
                          [replacementOrder.id]: value,
                        }));
                      }}
                      className="placeholder:text-gray-600"
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                      {defaultReplacementTags.map((tag) => (
                        <button
                          key={tag}
                          onClick={() => {
                            const current =
                              replacementTags[replacementOrder.id] || '';
                            const tags = current
                              .split(',')
                              .map((t) => t.trim())
                              .filter(Boolean);
                            if (!tags.includes(tag)) {
                              tags.push(tag);
                            }
                            setReplacementTags((prev) => ({
                              ...prev,
                              [replacementOrder.id]: tags.join(', '),
                            }));
                          }}
                          className="rounded-full border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border bg-white p-2">
                    <p className="text-sm font-semibold text-gray-900 mb-1">Note</p>
                    <textarea
                      rows={3}
                      placeholder="Internal note"
                      value={replacementNotes[replacementOrder.id] || ''}
                      onChange={(e) =>
                        setReplacementNotes((prev) => ({
                          ...prev,
                          [replacementOrder.id]: e.target.value,
                        }))
                      }
                      className="w-full border rounded-lg p-2 text-sm text-gray-900 placeholder:text-gray-600"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
              {actionError && (
                <span className="text-xs text-red-600 mr-auto">{actionError}</span>
              )}
              {actionNote && (
                <span className="text-xs text-emerald-700 mr-auto">
                  {actionNote}
                </span>
              )}
              <Button
                variant="ghost"
                onClick={() => setReplacementModalOrderId(null)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={creatingReplacement === replacementOrder.id}
                onClick={() => createReplacement(replacementOrder)}
                disabled={
                  (replacementItems[replacementOrder.id] || []).length === 0 ||
                  creatingReplacement === replacementOrder.id
                }
              >
                Create replacement order
              </Button>
            </div>
          </div>
        </div>
      )}
      {cancelModalOrderId && cancelModalOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <div>
                <h4 className="text-lg font-semibold text-gray-900">
                  Cancel {cancelModalOrder.name}
                </h4>
                <p className="text-xs text-gray-600">
                  Customer will be notified and refunded.
                </p>
              </div>
              <button
                onClick={() => setCancelModalOrderId(null)}
                className="text-gray-500 hover:text-gray-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
              {cancelShopifyOrderUrl && (
                <Button
                  variant="primary"
                  size="sm"
                  className="w-full justify-center"
                  onClick={() => window.open(cancelShopifyOrderUrl, '_blank')}
                >
                  <ExternalLink className="w-4 h-4 mr-2" />
                  Open Shopify order
                </Button>
              )}
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                <span className="font-medium">Refund amount:</span>{' '}
                {cancelRefundAmount || '—'}
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700">
                  Refund method
                </label>
                <select
                  value={cancelRefundMethodByOrder[cancelModalOrder.id] || 'ORIGINAL'}
                  onChange={(e) =>
                    setCancelRefundMethodByOrder((prev) => ({
                      ...prev,
                      [cancelModalOrder.id]: e.target.value as
                        | 'ORIGINAL'
                        | 'STORE_CREDIT',
                    }))
                  }
                  className="mt-1 h-8 w-full rounded-md border border-gray-200 bg-white px-2 text-sm text-gray-700"
                >
                  <option value="ORIGINAL">Original payment</option>
                  <option value="STORE_CREDIT">Store credit</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700">
                  Cancellation reason
                </label>
                <select
                  value={cancelReasonByOrder[cancelModalOrder.id] || 'CUSTOMER'}
                  onChange={(e) =>
                    setCancelReasonByOrder((prev) => ({
                      ...prev,
                      [cancelModalOrder.id]: e.target.value as
                        | 'CUSTOMER'
                        | 'INVENTORY'
                        | 'FRAUD'
                        | 'DECLINED'
                        | 'OTHER'
                        | 'STAFF',
                    }))
                  }
                  className="mt-1 h-8 w-full rounded-md border border-gray-200 bg-white px-2 text-sm text-gray-700"
                >
                  <option value="CUSTOMER">Customer changed/canceled order</option>
                  <option value="INVENTORY">Inventory</option>
                  <option value="FRAUD">Fraud</option>
                  <option value="DECLINED">Payment declined</option>
                  <option value="STAFF">Staff error</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700">
                  Staff note (internal)
                </label>
                <Input
                  value={cancelStaffNoteByOrder[cancelModalOrder.id] || ''}
                  onChange={(e) =>
                    setCancelStaffNoteByOrder((prev) => ({
                      ...prev,
                      [cancelModalOrder.id]: e.target.value,
                    }))
                  }
                  placeholder="Add an internal note"
                  className="mt-1 h-8 text-sm"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCancelModalOrderId(null)}
              >
                Back
              </Button>
              <Button
                variant="danger"
                size="sm"
                loading={cancelingShopifyId === cancelModalOrder.id}
                onClick={() => cancelShopifyOrder(cancelModalOrder.id)}
              >
                <ShieldX className="w-4 h-4 mr-1" />
                Cancel order
              </Button>
            </div>
          </div>
        </div>
      )}
      {refundModalOrderId && refundModalOrder && (() => {
        const shipping = refundModalOrder.totalShippingPrice
          ? parseFloat(refundModalOrder.totalShippingPrice)
          : 0;
        const alreadyRefunded = refundModalOrder.totalRefunded
          ? parseFloat(refundModalOrder.totalRefunded)
          : 0;
        const shouldRefundShipping = refundShipping[refundModalOrder.id] ?? false;
        const shippingRefundAmt = shouldRefundShipping
          ? parseFloat(refundShippingAmount[refundModalOrder.id] || '0') || 0
          : 0;

        // Calculate items refund from selected quantities
        const lineItemQuantities = refundLineItems[refundModalOrder.id] || {};
        let itemsRefundTotal = 0;
        refundModalOrder.lineItems.forEach((item) => {
          const qty = lineItemQuantities[item.id] || 0;
          const unitPrice = parseFloat(item.originalUnitPrice || '0');
          itemsRefundTotal += unitPrice * qty;
        });

        const totalRefund = itemsRefundTotal + shippingRefundAmt;

        return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <div>
                <h4 className="text-lg font-semibold text-gray-900">
                  Refund {refundModalOrder.name}
                </h4>
                <p className="text-xs text-gray-600">
                  Select items and quantities to refund
                </p>
              </div>
              <button
                onClick={() => setRefundModalOrderId(null)}
                className="text-gray-500 hover:text-gray-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
              {/* Line Items */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Items to refund
                </label>
                <div className="space-y-2">
                  {refundModalOrder.lineItems.map((item) => {
                    const qty = lineItemQuantities[item.id] ?? item.quantity;
                    const unitPrice = parseFloat(item.originalUnitPrice || '0');
                    const lineTotal = unitPrice * qty;

                    return (
                      <div
                        key={item.id}
                        className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 bg-white"
                      >
                        {item.imageUrl && (
                          <img
                            src={item.imageUrl}
                            alt={item.title}
                            className="w-12 h-12 rounded object-cover"
                          />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">
                            {item.title}
                          </p>
                          {item.variantTitle && item.variantTitle !== 'Default Title' && (
                            <p className="text-xs text-gray-500">{item.variantTitle}</p>
                          )}
                          <p className="text-xs text-gray-600">
                            ${unitPrice.toFixed(2)} each × {item.quantity} ordered
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setRefundLineItems((prev) => ({
                                ...prev,
                                [refundModalOrder.id]: {
                                  ...prev[refundModalOrder.id],
                                  [item.id]: Math.max(0, qty - 1),
                                },
                              }))
                            }
                            className="w-7 h-7 flex items-center justify-center rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
                            disabled={qty === 0}
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                          <span className="w-8 text-center text-sm font-medium text-gray-900">
                            {qty}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setRefundLineItems((prev) => ({
                                ...prev,
                                [refundModalOrder.id]: {
                                  ...prev[refundModalOrder.id],
                                  [item.id]: Math.min(item.quantity, qty + 1),
                                },
                              }))
                            }
                            className="w-7 h-7 flex items-center justify-center rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
                            disabled={qty >= item.quantity}
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                          <span className="w-16 text-right text-sm font-medium text-gray-900">
                            ${lineTotal.toFixed(2)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {alreadyRefunded > 0 && (
                  <p className="text-xs text-orange-600 mt-2">
                    Note: ${alreadyRefunded.toFixed(2)} already refunded on this order
                  </p>
                )}
              </div>

              {/* Shipping Refund */}
              {shipping > 0 && (
                <div className="rounded-lg border border-gray-200 p-3 space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={refundShipping[refundModalOrder.id] ?? false}
                      onChange={(e) =>
                        setRefundShipping((prev) => ({
                          ...prev,
                          [refundModalOrder.id]: e.target.checked,
                        }))
                      }
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm font-medium text-gray-700">Refund shipping</span>
                  </label>
                  {(refundShipping[refundModalOrder.id] ?? false) && (
                    <div className="relative ml-6">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        max={shipping}
                        value={refundShippingAmount[refundModalOrder.id] ?? shipping.toFixed(2)}
                        onChange={(e) =>
                          setRefundShippingAmount((prev) => ({
                            ...prev,
                            [refundModalOrder.id]: e.target.value,
                          }))
                        }
                        className="pl-7"
                        placeholder={shipping.toFixed(2)}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Refund Method */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Refund method
                </label>
                <select
                  value={refundMethod[refundModalOrder.id] ?? 'ORIGINAL'}
                  onChange={(e) =>
                    setRefundMethod((prev) => ({
                      ...prev,
                      [refundModalOrder.id]: e.target.value as 'ORIGINAL' | 'STORE_CREDIT',
                    }))
                  }
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="ORIGINAL">Refund to original payment method</option>
                  <option value="STORE_CREDIT">Store credit</option>
                </select>
              </div>

              {/* Reason */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Reason (optional)
                </label>
                <Input
                  value={refundReason[refundModalOrder.id] ?? ''}
                  onChange={(e) =>
                    setRefundReason((prev) => ({
                      ...prev,
                      [refundModalOrder.id]: e.target.value,
                    }))
                  }
                  placeholder="e.g., Customer requested refund"
                />
              </div>

              {/* Notify Customer */}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={refundNotify[refundModalOrder.id] ?? true}
                  onChange={(e) =>
                    setRefundNotify((prev) => ({
                      ...prev,
                      [refundModalOrder.id]: e.target.checked,
                    }))
                  }
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">Send notification to customer</span>
              </label>

              {/* Refund Summary */}
              {totalRefund > 0 && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm">
                  <div className="flex justify-between text-blue-900">
                    <span className="font-medium">Total refund:</span>
                    <span className="font-semibold">${totalRefund.toFixed(2)}</span>
                  </div>
                  {itemsRefundTotal > 0 && shippingRefundAmt > 0 && (
                    <div className="text-xs text-blue-700 mt-1">
                      Items: ${itemsRefundTotal.toFixed(2)} + Shipping: ${shippingRefundAmt.toFixed(2)}
                    </div>
                  )}
                </div>
              )}

              {actionError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {actionError}
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRefundModalOrderId(null)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={refundingOrderId === refundModalOrder.id}
                onClick={() => submitRefund(refundModalOrder)}
              >
                <DollarSign className="w-4 h-4 mr-1" />
                Issue refund
              </Button>
            </div>
          </div>
        </div>
        );
      })()}
      {editOrderModalId && editOrderData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-5xl rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <div>
                <h4 className="text-lg font-semibold text-gray-900">
                  Edit order {editOrderData.name}
                </h4>
                <p className="text-xs text-gray-600">
                  Add or remove items from this order
                </p>
              </div>
              <button
                onClick={() => setEditOrderModalId(null)}
                className="text-gray-500 hover:text-gray-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-5 py-3 max-h-[84vh] overflow-y-auto">
              <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="space-y-3">
                  <div className="rounded-xl border bg-white p-2">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-sm font-semibold text-gray-900">Products</p>
                    </div>
                    <div className="flex items-center gap-2 border rounded-lg px-3 py-2 bg-white">
                      <Search className="w-4 h-4 text-gray-500" />
                      <input
                        type="text"
                        placeholder="Search products to add"
                        value={editOrderProductSearch}
                        onChange={(e) => setEditOrderProductSearch(e.target.value)}
                        className="flex-1 text-sm text-gray-900 placeholder:text-gray-600 outline-none"
                      />
                      {editOrderSearching && (
                        <RefreshCw className="w-4 h-4 text-gray-500 animate-spin" />
                      )}
                    </div>

                    {editOrderSearchResults.length > 0 && (
                      <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border divide-y">
                        {editOrderSearchResults.map((product) => {
                          const variantsForOptions =
                            variantOptions[product.id]?.variants?.length
                              ? variantOptions[product.id].variants
                              : product.variants;
                          const colorName = getSearchOptionName(
                            variantsForOptions,
                            'color'
                          );
                          const sizeName = getSearchOptionName(
                            variantsForOptions,
                            'size'
                          );
                          const colorOptions = getSearchOptionValues(
                            variantsForOptions,
                            colorName
                          );
                          const sizeOptions = getSearchOptionValues(
                            variantsForOptions,
                            sizeName
                          );
                          const selection = replacementSearchSelection[product.id] || {};
                          const selectedColor =
                            selection.color || colorOptions[0] || '';
                          const variantsForColor = colorName
                            ? variantsForOptions.filter(
                                (variantItem) =>
                                  getVariantOptionValue(variantItem, colorName) ===
                                  selectedColor
                              )
                            : variantsForOptions;
                          const sizeOptionsForColor = sizeName
                            ? getSearchOptionValues(variantsForColor, sizeName)
                            : sizeOptions;
                          const selectedSize =
                            selection.size ||
                            sizeOptionsForColor[0] ||
                            sizeOptions[0] ||
                            '';
                          const matchedVariant = findSearchVariant(
                            variantsForOptions,
                            colorName,
                            sizeName,
                            selectedColor,
                            selectedSize
                          );
                          const fallbackVariant =
                            matchedVariant ||
                            findSearchVariantByValues(
                              variantsForOptions,
                              selectedColor,
                              selectedSize
                            ) ||
                            findSearchVariantByTitle(
                              variantsForOptions,
                              selectedColor,
                              selectedSize
                            );
                          const variant =
                            (selection.variantId
                              ? variantsForOptions.find(
                                  (item) => item.id === selection.variantId
                                )
                              : undefined) ||
                            fallbackVariant ||
                            variantsForOptions[0];

                          return (
                            <div key={product.id} className="p-3">
                              <div className="flex items-center gap-3">
                                <div className="h-18 w-18 rounded-md bg-white border overflow-hidden flex items-center justify-center">
                                  {variant?.imageUrl || product.imageUrl ? (
                                    <img
                                      src={variant?.imageUrl || product.imageUrl}
                                      alt={product.title}
                                      className="h-full w-full object-cover"
                                    />
                                  ) : (
                                    <Package className="w-4 h-4 text-gray-400" />
                                  )}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium text-gray-900 truncate">
                                    {product.title}
                                  </p>
                                  <p className="text-xs text-gray-600">
                                    {variant?.title || 'Variant'}
                                  </p>
                                </div>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={async () => {
                                    const latestSelection =
                                      replacementSearchSelectionRef.current[product.id] || {};
                                    const latestColor =
                                      latestSelection.color || colorOptions[0] || '';
                                    let candidateVariants = variantsForOptions;
                                    let optionColorName = colorName;
                                    let optionSizeName = sizeName;
                                    const variantsForLatestColor = optionColorName
                                      ? candidateVariants.filter(
                                          (variantItem) =>
                                            getVariantOptionValue(
                                              variantItem,
                                              optionColorName
                                            ) === latestColor
                                        )
                                      : candidateVariants;
                                    const sizeOptionsForLatestColor = optionSizeName
                                      ? getSearchOptionValues(
                                          variantsForLatestColor,
                                          optionSizeName
                                        )
                                      : sizeOptions;
                                    const latestSize =
                                      latestSelection.size ||
                                      sizeOptionsForLatestColor[0] ||
                                      sizeOptions[0] ||
                                      '';

                                    let latestVariant =
                                      (latestSelection.variantId
                                        ? candidateVariants.find(
                                            (item) => item.id === latestSelection.variantId
                                          )
                                        : undefined) ||
                                      findSearchVariant(
                                        candidateVariants,
                                        optionColorName,
                                        optionSizeName,
                                        latestColor,
                                        latestSize
                                      ) ||
                                      findSearchVariantByValues(
                                        candidateVariants,
                                        latestColor,
                                        latestSize
                                      ) ||
                                      findSearchVariantByTitle(
                                        candidateVariants,
                                        latestColor,
                                        latestSize
                                      );

                                    if (
                                      !latestVariant &&
                                      product.id &&
                                      !variantOptions[product.id]
                                    ) {
                                      const loaded = await loadVariantsForProduct(product.id);
                                      if (loaded?.variants?.length) {
                                        candidateVariants = loaded.variants;
                                        optionColorName = getSearchOptionName(
                                          candidateVariants,
                                          'color'
                                        );
                                        optionSizeName = getSearchOptionName(
                                          candidateVariants,
                                          'size'
                                        );
                                        const variantsForLoadedColor = optionColorName
                                          ? candidateVariants.filter(
                                              (variantItem) =>
                                                getVariantOptionValue(
                                                  variantItem,
                                                  optionColorName
                                                ) === latestColor
                                            )
                                          : candidateVariants;
                                        const sizeOptionsForLoadedColor =
                                          optionSizeName
                                            ? getSearchOptionValues(
                                                variantsForLoadedColor,
                                                optionSizeName
                                              )
                                            : sizeOptions;
                                        const resolvedSize =
                                          latestSelection.size ||
                                          sizeOptionsForLoadedColor[0] ||
                                          sizeOptions[0] ||
                                          '';
                                        latestVariant =
                                          (latestSelection.variantId
                                            ? candidateVariants.find(
                                                (item) =>
                                                  item.id === latestSelection.variantId
                                              )
                                            : undefined) ||
                                          findSearchVariant(
                                            candidateVariants,
                                            optionColorName,
                                            optionSizeName,
                                            latestColor,
                                            resolvedSize
                                          ) ||
                                          findSearchVariantByValues(
                                            candidateVariants,
                                            latestColor,
                                            resolvedSize
                                          ) ||
                                          findSearchVariantByTitle(
                                            candidateVariants,
                                            latestColor,
                                            resolvedSize
                                          );
                                      }
                                    }

                                    const finalVariant =
                                      latestVariant || candidateVariants[0];

                                    if (finalVariant) {
                                      addEditOrderItem(
                                        editOrderData.id,
                                        product,
                                        finalVariant
                                      );
                                    }
                                  }}
                                >
                                  Add
                                </Button>
                              </div>

                              <div className="mt-2 grid grid-cols-2 gap-2">
                                {colorName && colorOptions.length > 0 && (
                                  <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-gray-500">
                                      Color
                                    </label>
                                    <select
                                      className="w-full border rounded px-2 py-1 text-xs text-gray-900 bg-white"
                                      value={selectedColor}
                                      onChange={(e) => {
                                        const nextColor = e.target.value;
                                        const nextVariantsForColor = colorName
                                          ? variantsForOptions.filter(
                                              (variantItem) =>
                                                getVariantOptionValue(
                                                  variantItem,
                                                  colorName
                                                ) === nextColor
                                            )
                                          : variantsForOptions;
                                        const nextSizeOptions = sizeName
                                          ? getSearchOptionValues(
                                              nextVariantsForColor,
                                              sizeName
                                            )
                                          : sizeOptions;
                                        const nextSize = nextSizeOptions[0] || '';
                                        const nextVariant = findSearchVariant(
                                          variantsForOptions,
                                          colorName,
                                          sizeName,
                                          nextColor,
                                          nextSize
                                        );
                                        setReplacementSearchSelection((prev) => ({
                                          ...prev,
                                          [product.id]: {
                                            color: nextColor,
                                            size: nextSize,
                                            variantId: nextVariant?.id,
                                          },
                                        }));
                                      }}
                                    >
                                      {colorOptions.map((color) => (
                                        <option key={color} value={color}>
                                          {color}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                                {sizeName && sizeOptionsForColor.length > 0 && (
                                  <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-gray-500">
                                      Size
                                    </label>
                                    <select
                                      className="w-full border rounded px-2 py-1 text-xs text-gray-900 bg-white"
                                      value={selectedSize}
                                      onChange={(e) => {
                                        const nextSize = e.target.value;
                                        const nextVariant = findSearchVariant(
                                          variantsForOptions,
                                          colorName,
                                          sizeName,
                                          selectedColor,
                                          nextSize
                                        );
                                        setReplacementSearchSelection((prev) => ({
                                          ...prev,
                                          [product.id]: {
                                            ...(prev[product.id] || {}),
                                            size: nextSize,
                                            variantId: nextVariant?.id,
                                          },
                                        }));
                                      }}
                                    >
                                      {sizeOptionsForColor.map((size) => (
                                        <option key={size} value={size}>
                                          {size}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="mt-4 space-y-2 max-h-80 overflow-y-auto">
                      {(editOrderItems[editOrderData.id] || []).map((item) => {
                        const productVariants =
                          variantOptions[item.productId || '']?.variants || [];
                        const colorName = getSearchOptionName(productVariants, 'color');
                        const sizeName = getSearchOptionName(productVariants, 'size');
                        const colorOptions = getSearchOptionValues(
                          productVariants,
                          colorName
                        );
                        const sizeOptions = getSearchOptionValues(
                          productVariants,
                          sizeName
                        );
                        const currentColor =
                          item.selectedOptions?.find(
                            (opt) => opt.name.toLowerCase().includes('color')
                          )?.value ||
                          colorOptions[0] ||
                          '';
                        const currentSize =
                          item.selectedOptions?.find(
                            (opt) => opt.name.toLowerCase().includes('size')
                          )?.value ||
                          sizeOptions[0] ||
                          '';

                        return (
                          <div
                            key={item.id}
                            className="flex items-start gap-3 p-3 rounded-lg border bg-gray-50"
                          >
                            <div className="h-16 w-16 rounded-md bg-white border overflow-hidden flex items-center justify-center shrink-0">
                              {item.imageUrl ? (
                                <img
                                  src={item.imageUrl}
                                  alt={item.title}
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <Package className="w-4 h-4 text-gray-400" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0 space-y-2">
                              <div>
                                <p className="text-sm font-medium text-gray-900 truncate">
                                  {item.title}
                                </p>
                                <p className="text-xs text-gray-600 truncate">
                                  {item.variantTitle}
                                  {item.sku && ` • ${item.sku}`}
                                </p>
                                {item.price && (
                                  <p className="text-xs text-gray-500">
                                    ${parseFloat(item.price).toFixed(2)}
                                  </p>
                                )}
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                {colorName && colorOptions.length > 0 && (
                                  <div className="flex flex-col gap-0.5">
                                    <label className="text-[10px] font-medium text-gray-500">
                                      Color
                                    </label>
                                    <select
                                      className="w-full border rounded px-2 py-1 text-xs text-gray-900 bg-white"
                                      value={currentColor}
                                      onChange={(e) => {
                                        const newColor = e.target.value;
                                        const newVariant = findSearchVariant(
                                          productVariants,
                                          colorName,
                                          sizeName,
                                          newColor,
                                          currentSize
                                        );
                                        if (newVariant) {
                                          updateEditOrderItem(editOrderData.id, item.id, {
                                            variantId: newVariant.id,
                                            variantTitle: newVariant.title,
                                            imageUrl: newVariant.imageUrl,
                                            selectedOptions: newVariant.selectedOptions,
                                            sku: newVariant.sku,
                                            price: newVariant.price,
                                          });
                                        }
                                      }}
                                    >
                                      {colorOptions.map((color) => (
                                        <option key={color} value={color}>
                                          {color}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                                {sizeName && sizeOptions.length > 0 && (
                                  <div className="flex flex-col gap-0.5">
                                    <label className="text-[10px] font-medium text-gray-500">
                                      Size
                                    </label>
                                    <select
                                      className="w-full border rounded px-2 py-1 text-xs text-gray-900 bg-white"
                                      value={currentSize}
                                      onChange={(e) => {
                                        const newSize = e.target.value;
                                        const newVariant = findSearchVariant(
                                          productVariants,
                                          colorName,
                                          sizeName,
                                          currentColor,
                                          newSize
                                        );
                                        if (newVariant) {
                                          updateEditOrderItem(editOrderData.id, item.id, {
                                            variantId: newVariant.id,
                                            variantTitle: newVariant.title,
                                            imageUrl: newVariant.imageUrl,
                                            selectedOptions: newVariant.selectedOptions,
                                            sku: newVariant.sku,
                                            price: newVariant.price,
                                          });
                                        }
                                      }}
                                    >
                                      {sizeOptions.map((size) => (
                                        <option key={size} value={size}>
                                          {size}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="flex items-center border rounded-lg bg-white">
                                <button
                                  onClick={() =>
                                    updateEditOrderItem(editOrderData.id, item.id, {
                                      quantity: Math.max(1, item.quantity - 1),
                                    })
                                  }
                                  className="px-2 py-1 text-gray-600 hover:bg-gray-100 rounded-l-lg"
                                >
                                  <Minus className="w-3 h-3" />
                                </button>
                                <span className="px-2 text-sm font-medium text-gray-900 min-w-[24px] text-center">
                                  {item.quantity}
                                </span>
                                <button
                                  onClick={() =>
                                    updateEditOrderItem(editOrderData.id, item.id, {
                                      quantity: item.quantity + 1,
                                    })
                                  }
                                  className="px-2 py-1 text-gray-600 hover:bg-gray-100 rounded-r-lg"
                                >
                                  <Plus className="w-3 h-3" />
                                </button>
                              </div>
                              <button
                                onClick={() =>
                                  removeEditOrderItem(editOrderData.id, item.id)
                                }
                                className="p-1 text-red-600 hover:bg-red-50 rounded"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                      {(editOrderItems[editOrderData.id] || []).length === 0 && (
                        <p className="text-sm text-gray-500 text-center py-4">
                          No items in order. Search and add products above.
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="rounded-xl border bg-white p-4">
                    <p className="text-sm font-semibold text-gray-900 mb-3">
                      Order Summary
                    </p>
                    {(() => {
                      const items = editOrderItems[editOrderData.id] || [];
                      const currentTotal = items.reduce((sum, item) => {
                        const price = item.price ? parseFloat(item.price) : 0;
                        return sum + price * item.quantity;
                      }, 0);
                      const originalTotal = editOrderData.lineItems.reduce((sum, li) => {
                        const price = li.originalUnitPrice ? parseFloat(li.originalUnitPrice) : 0;
                        return sum + price * li.quantity;
                      }, 0);
                      const hasChanges = items.some(item =>
                        !item.originalLineItemId ||
                        (item.originalVariantId && item.variantId !== item.originalVariantId)
                      );
                      return (
                        <div className="space-y-2 text-sm">
                          <div className="flex justify-between text-gray-600">
                            <span>Items</span>
                            <span>
                              {items.reduce((sum, item) => sum + item.quantity, 0)}
                            </span>
                          </div>
                          <div className="flex justify-between text-gray-600">
                            <span>Original items</span>
                            <span>
                              {editOrderData.lineItems.reduce((sum, li) => sum + li.quantity, 0)}
                            </span>
                          </div>
                          <div className="border-t pt-2 mt-2">
                            <div className="flex justify-between text-gray-600">
                              <span>Original subtotal</span>
                              <span>${originalTotal.toFixed(2)}</span>
                            </div>
                            <div className="flex justify-between text-gray-600">
                              <span>New subtotal</span>
                              <span>${currentTotal.toFixed(2)}</span>
                            </div>
                            {hasChanges && currentTotal > originalTotal && (
                              <div className="flex justify-between text-amber-600 font-medium">
                                <span>Auto-discount</span>
                                <span>-${(currentTotal - originalTotal).toFixed(2)}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  <div className="rounded-xl border bg-white p-4">
                    <label className="text-sm font-semibold text-gray-900">
                      Staff Note
                    </label>
                    <textarea
                      value={editOrderNote[editOrderData.id] || ''}
                      onChange={(e) =>
                        setEditOrderNote((prev) => ({
                          ...prev,
                          [editOrderData.id]: e.target.value,
                        }))
                      }
                      placeholder="Add an internal note for this edit"
                      className="mt-2 w-full h-20 border rounded-lg px-3 py-2 text-sm text-gray-900 placeholder:text-gray-600 resize-none"
                    />
                  </div>

                  {/* Price difference info */}
                  {(() => {
                    const items = editOrderItems[editOrderData.id] || [];
                    const priceDiff = items.reduce((total, item) => {
                      if (item.originalPrice && item.price && item.originalVariantId && item.variantId !== item.originalVariantId) {
                        const diff = parseFloat(item.price) - parseFloat(item.originalPrice);
                        return total + (diff > 0 ? diff * item.quantity : 0);
                      }
                      return total;
                    }, 0);
                    if (priceDiff > 0) {
                      return (
                        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                          <p className="text-sm font-medium text-amber-800">
                            Price Adjustment
                          </p>
                          <p className="text-xs text-amber-700 mt-1">
                            New items are ${priceDiff.toFixed(2)} more expensive. A discount will be automatically applied so the customer is not charged extra.
                          </p>
                        </div>
                      );
                    }
                    return null;
                  })()}

                  {/* Notify customer checkbox */}
                  <div className="rounded-xl border bg-white p-4">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editOrderNotifyCustomer[editOrderData.id] ?? false}
                        onChange={(e) =>
                          setEditOrderNotifyCustomer((prev) => ({
                            ...prev,
                            [editOrderData.id]: e.target.checked,
                          }))
                        }
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          Notify customer
                        </p>
                        <p className="text-xs text-gray-500">
                          Send an email to the customer about this order change
                        </p>
                      </div>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 border-t px-6 py-4">
              {actionError && (
                <span className="text-xs text-red-600 mr-auto">{actionError}</span>
              )}
              {actionNote && (
                <span className="text-xs text-emerald-700 mr-auto">{actionNote}</span>
              )}
              <Button
                variant="ghost"
                onClick={() => setEditOrderModalId(null)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={editingOrder === editOrderData.id}
                onClick={() => submitEditOrder(editOrderData)}
                disabled={
                  (editOrderItems[editOrderData.id] || []).length === 0 ||
                  editingOrder === editOrderData.id
                }
              >
                Save changes
              </Button>
            </div>
          </div>
        </div>
      )}
      {/* Edit Order Success Modal */}
      {editOrderSuccessId && (() => {
        const successOrder = orders?.find((o) => o.id === editOrderSuccessId);
        const successPrintify = successOrder ? getPrintifyMatch(successOrder.id) : null;
        const printifyUrl = successPrintify && printifyShopId
          ? `https://printify.com/app/store/${printifyShopId}/order/${successPrintify.order.id}`
          : successPrintify
          ? `https://printify.com/app/order/${successPrintify.order.id}`
          : null;

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
              <div className="px-5 py-4 border-b">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
                    <Check className="w-5 h-5 text-green-600" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900">
                      Order Updated Successfully
                    </h3>
                    <p className="text-xs text-gray-600">
                      {editOrderSuccessName} has been modified in Shopify
                    </p>
                  </div>
                </div>
              </div>

              <div className="px-5 py-4 space-y-4">
                {successPrintify ? (
                  <>
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                      <p className="text-sm text-amber-800 font-medium">
                        Printify Order Needs Attention
                      </p>
                      <p className="text-xs text-amber-700 mt-1">
                        This order has a linked Printify order. You may need to update or cancel it manually.
                      </p>
                    </div>

                    {printifyUrl && (
                      <a
                        href={printifyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg border hover:bg-gray-100 transition-colors"
                      >
                        <ExternalLink className="w-4 h-4 text-gray-500" />
                        <div className="flex-1">
                          <p className="text-sm font-medium text-gray-900">
                            Open Printify Order
                          </p>
                          <p className="text-xs text-gray-500">
                            #{successPrintify.order.id.slice(-8)} - {successPrintify.order.status}
                          </p>
                        </div>
                      </a>
                    )}

                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editOrderPrintifyAcknowledged}
                        onChange={(e) => setEditOrderPrintifyAcknowledged(e.target.checked)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-700">
                        I have reviewed the Printify order
                      </span>
                    </label>
                  </>
                ) : (
                  <p className="text-sm text-gray-600">
                    The order has been updated. No linked Printify order was found.
                  </p>
                )}
              </div>

              <div className="px-5 py-4 border-t flex justify-end">
                <Button
                  onClick={() => {
                    setEditOrderSuccessId(null);
                    setEditOrderSuccessName(null);
                    setEditOrderPrintifyAcknowledged(false);
                  }}
                  disabled={!!successPrintify && !editOrderPrintifyAcknowledged}
                >
                  {successPrintify ? 'Close' : 'Done'}
                </Button>
              </div>
            </div>
          </div>
        );
      })()}
      {warningOrder &&
        warningPrintify &&
        printifyAddressNeedsUpdate[warningOrder.id] && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
              <div className="px-5 py-4 border-b">
                <h3 className="text-sm font-semibold text-gray-900">
                  Update Printify Address
                </h3>
                <p className="text-xs text-gray-600 mt-1">
                  Shopify shipping was updated for {warningOrder.name}. Update
                  Printify to keep the order aligned.
                </p>
              </div>
              <div className="px-5 py-4 space-y-3 text-sm text-gray-700">
                {/* New Address Display - Click to Copy */}
                {warningOrder.shippingAddress && (() => {
                  const addr = warningOrder.shippingAddress;
                  const copyField = (field: string, value: string) => {
                    navigator.clipboard.writeText(value);
                    setCopiedField(field);
                    setTimeout(() => setCopiedField(null), 1200);
                  };
                  const CopyableField = ({ label, value, field }: { label: string; value: string | undefined; field: string }) => {
                    if (!value) return null;
                    const isCopied = copiedField === field;
                    return (
                      <button
                        onClick={() => copyField(field, value)}
                        className={`w-full flex items-center justify-between py-1.5 px-2 -mx-2 rounded hover:bg-blue-50 transition-colors text-left ${isCopied ? 'bg-green-50' : ''}`}
                        title="Click to copy"
                      >
                        <div className="flex-1 min-w-0">
                          <span className="text-xs text-gray-500">{label}</span>
                          <div className={`text-sm truncate ${isCopied ? 'text-green-700' : 'text-gray-900'}`}>{value}</div>
                        </div>
                        <div className="ml-2 flex-shrink-0">
                          {isCopied ? (
                            <span className="text-xs text-green-600 font-medium">Copied!</span>
                          ) : (
                            <Copy className="w-3.5 h-3.5 text-gray-300" />
                          )}
                        </div>
                      </button>
                    );
                  };
                  return (
                    <div className="bg-gray-50 rounded-lg p-3 border">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-medium text-gray-500 uppercase">New Address</span>
                        <span className="text-xs text-gray-400">Click any field to copy</span>
                      </div>
                      <div className="space-y-0">
                        <CopyableField label="First Name" value={addr.firstName} field="firstName" />
                        <CopyableField label="Last Name" value={addr.lastName} field="lastName" />
                        {addr.company && <CopyableField label="Company" value={addr.company} field="company" />}
                        <CopyableField label="Address Line 1" value={addr.address1} field="address1" />
                        {addr.address2 && <CopyableField label="Address Line 2" value={addr.address2} field="address2" />}
                        <CopyableField label="City" value={addr.city} field="city" />
                        <CopyableField label="State/Province" value={addr.provinceCode || addr.province} field="province" />
                        <CopyableField label="ZIP/Postal Code" value={addr.zip} field="zip" />
                        <CopyableField label="Country" value={addr.countryCode || addr.country} field="country" />
                        {addr.phone && <CopyableField label="Phone" value={addr.phone} field="phone" />}
                      </div>
                    </div>
                  );
                })()}
                {warningPrintifyOrderUrl && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() =>
                      window.open(warningPrintifyOrderUrl, '_blank')
                    }
                    className="w-full justify-center"
                  >
                    <ExternalLink className="w-4 h-4 mr-2" />
                    Open Printify order
                  </Button>
                )}
                <label className="flex items-start gap-2 text-sm text-gray-800">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4"
                    checked={!!printifyAddressConfirmed[warningOrder.id]}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setPrintifyAddressConfirmed((prev) => ({
                        ...prev,
                        [warningOrder.id]: checked,
                      }));
                      if (checked) {
                        confirmPrintifyAddress(
                          warningOrder.id,
                          warningPrintify.order.id
                        );
                      }
                    }}
                    disabled={confirmingPrintifyId === warningOrder.id}
                  />
                  I updated the address in Printify
                </label>
              </div>
              <div className="flex items-center justify-end gap-2 border-t px-5 py-4">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={closePrintifyWarning}
                  disabled={
                    !printifyAddressConfirmed[warningOrder.id] ||
                    confirmingPrintifyId === warningOrder.id
                  }
                >
                  Done
                </Button>
              </div>
            </div>
          </div>
        )}
      {/* Printify Support Modal */}
      {printifySupportOrderId && (() => {
        const supportOrder = orders?.find((o) => o.id === printifySupportOrderId);
        const supportPrintify = supportOrder ? getPrintifyMatch(supportOrder.id) : null;
        if (!supportOrder || !supportPrintify) return null;

        const printifyOrderUrl = printifyShopId
          ? `https://printify.com/app/store/${printifyShopId}/order/${supportPrintify.order.id}`
          : `https://printify.com/app/order/${supportPrintify.order.id}`;

        // Generate support message - simplified order ID only
        const printifyDisplayId = supportPrintify.order.app_order_id || supportPrintify.order.id;
        const supportMessage = `Order Id: ${supportOrder.name} > #${printifyDisplayId}`;

        const copySupportMessage = () => {
          navigator.clipboard.writeText(supportMessage);
          setSupportMessageCopied(true);
          setTimeout(() => setSupportMessageCopied(false), 2000);
        };

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl max-h-[90vh] flex flex-col">
              <div className="px-5 py-4 border-b flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">
                    Contact Printify Support
                  </h3>
                  <p className="text-xs text-gray-600 mt-0.5">
                    For defects, shipping issues, or refund requests
                  </p>
                </div>
                <button
                  onClick={() => setPrintifySupportOrderId(null)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-2">
                  <p className="text-xs text-blue-800">
                    <strong>How to start chat:</strong> Click the button below, then look for the chat icon (💬) in the bottom-right corner of Printify.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => window.open(printifyOrderUrl, '_blank')}
                    className="flex-1 justify-center"
                  >
                    <MessageSquare className="w-4 h-4 mr-2" />
                    Open Order &amp; Start Chat
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => window.open('https://help.printify.com', '_blank')}
                    className="justify-center"
                  >
                    <ExternalLink className="w-4 h-4 mr-1" />
                    Help Docs
                  </Button>
                </div>

                <div className="bg-gray-50 rounded-lg border">
                  <div className="flex items-center justify-between px-3 py-2 border-b bg-gray-100 rounded-t-lg">
                    <span className="text-xs font-medium text-gray-600">Order Details (copy for support chat)</span>
                    <button
                      onClick={copySupportMessage}
                      className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
                    >
                      {supportMessageCopied ? (
                        <>
                          <Check className="w-3 h-3" />
                          Copied!
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          Copy All
                        </>
                      )}
                    </button>
                  </div>
                  <pre className="p-3 text-xs text-gray-700 whitespace-pre-wrap font-mono overflow-x-auto">
                    {supportMessage}
                  </pre>
                </div>

                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <p className="text-xs text-amber-800">
                    <strong>Tip:</strong> Printify may provide refunds or free replacements for:
                  </p>
                  <ul className="text-xs text-amber-700 mt-1 ml-4 list-disc space-y-0.5">
                    <li>Print quality defects</li>
                    <li>Wrong items shipped</li>
                    <li>Shipping damage (with photos)</li>
                    <li>Lost packages after carrier confirms delivery issue</li>
                  </ul>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 border-t px-5 py-4">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPrintifySupportOrderId(null)}
                >
                  Close
                </Button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
