'use client';

/**
 * Orders On Hold - Manage Printify orders on hold for combining
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatDateFull } from '@/lib/utils';
import {
  Package,
  RefreshCw,
  Layers,
  AlertCircle,
  CheckCircle,
} from 'lucide-react';

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

interface OrderOnHold {
  id: string;
  printifyId: string;
  externalId?: string;
  label?: string;
  status: string;
  customerName: string;
  customerEmail?: string;
  address: PrintifyAddress;
  createdAt: string;
  itemCount: number;
  items: {
    title: string;
    variant?: string;
    quantity: number;
    sku?: string;
    status: string;
  }[];
  canCancel: boolean;
  totalPrice: number;
}

interface CombineCandidate {
  customerEmail: string;
  customerName: string;
  orderCount: number;
  orders: OrderOnHold[];
}

interface OrdersOnHoldData {
  orders: OrderOnHold[];
  combineCandidates: CombineCandidate[];
  totalOnHold: number;
  customersWithMultiple: number;
}

/**
 * Check if two addresses match
 * Returns null if they match, or a description of what differs
 */
function checkAddressMatch(addr1: PrintifyAddress, addr2: PrintifyAddress): string | null {
  const normalize = (value?: string) => (value || '').toLowerCase().trim();

  const checks: { field: string; val1: string; val2: string }[] = [
    { field: 'Address', val1: normalize(addr1.address1), val2: normalize(addr2.address1) },
    { field: 'City', val1: normalize(addr1.city), val2: normalize(addr2.city) },
    { field: 'ZIP', val1: normalize(addr1.zip), val2: normalize(addr2.zip) },
    { field: 'Country', val1: normalize(addr1.country), val2: normalize(addr2.country) },
  ];

  for (const check of checks) {
    if (check.val1 !== check.val2) {
      return `${check.field} differs`;
    }
  }

  // Check region/state (if both are present)
  const region1 = normalize(addr1.region);
  const region2 = normalize(addr2.region);
  if (region1 && region2 && region1 !== region2) {
    return 'State/Region differs';
  }

  return null;
}

export default function OrdersOnHoldPage() {
  const queryClient = useQueryClient();
  const [isSyncing, setIsSyncing] = useState(false);
  const [combiningEmail, setCombiningEmail] = useState<string | null>(null);
  const [combineResult, setCombineResult] = useState<{ email: string; success: boolean; message: string } | null>(null);

  const { data, isLoading, refetch, isFetching } = useQuery<OrdersOnHoldData>({
    queryKey: ['orders-on-hold'],
    queryFn: async () => {
      const res = await fetch('/api/admin/printify/orders-on-hold');
      if (!res.ok) throw new Error('Failed to fetch orders');
      return res.json();
    },
  });

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      await fetch('/api/admin/printify/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullSync: true }),
      });
      await refetch();
    } finally {
      setIsSyncing(false);
    }
  };

  const handleCombineOrders = async (orders: OrderOnHold[], customerEmail: string) => {
    if (orders.length < 2) return;

    const order1 = orders[0];
    const order2 = orders[1];

    setCombiningEmail(customerEmail);
    setCombineResult(null);

    try {
      const res = await fetch('/api/admin/printify/combine-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderNumber1: order1.externalId || order1.label || order1.printifyId,
          orderNumber2: order2.externalId || order2.label || order2.printifyId,
        }),
      });

      const result = await res.json();

      if (!res.ok) {
        setCombineResult({ email: customerEmail, success: false, message: result.error || 'Failed to combine orders' });
        return;
      }

      setCombineResult({ email: customerEmail, success: true, message: `Combined into order ${result.combinedOrderLabel}` });

      // Refresh the orders list
      await refetch();
      queryClient.invalidateQueries({ queryKey: ['printify-insights'] });
    } catch (err) {
      setCombineResult({ email: customerEmail, success: false, message: err instanceof Error ? err.message : 'Failed to combine orders' });
    } finally {
      setCombiningEmail(null);
    }
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-6">
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Combine Orders</h1>
          <p className="text-sm text-gray-600 mt-1">
            Combine multiple orders from the same customer into one shipment
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleSync}
          loading={isSyncing || isFetching}
        >
          <RefreshCw className="w-4 h-4 mr-1" />
          Sync
        </Button>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-amber-50 rounded-lg border border-amber-200 p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-100 text-amber-600 flex items-center justify-center">
              <Package className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm text-amber-700">Orders On Hold</p>
              <p className="text-2xl font-semibold text-amber-900">{data?.totalOnHold || 0}</p>
            </div>
          </div>
        </div>
        <div className="bg-purple-50 rounded-lg border border-purple-200 p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-purple-100 text-purple-600 flex items-center justify-center">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm text-purple-700">Ready to Combine</p>
              <p className="text-2xl font-semibold text-purple-900">{data?.customersWithMultiple || 0}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Combine Candidates */}
      {data?.combineCandidates && data.combineCandidates.length > 0 && (
        <div className="bg-purple-50 rounded-lg border border-purple-200 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Layers className="w-5 h-5 text-purple-500" />
            <h2 className="text-lg font-semibold text-gray-900">
              Ready to Combine ({data.combineCandidates.length} customers)
            </h2>
          </div>

          <div className="space-y-6">
            {data.combineCandidates.map((candidate) => {
              const mismatch = candidate.orders.length >= 2
                ? checkAddressMatch(candidate.orders[0].address, candidate.orders[1].address)
                : null;
              const isCombining = combiningEmail === candidate.customerEmail;
              const result = combineResult?.email === candidate.customerEmail ? combineResult : null;

              return (
                <div
                  key={candidate.customerEmail}
                  className="bg-white rounded-lg border p-4"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="font-medium text-gray-900">{candidate.customerName}</p>
                      <p className="text-sm text-gray-600">{candidate.customerEmail}</p>
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleCombineOrders(candidate.orders, candidate.customerEmail)}
                      loading={isCombining}
                      disabled={isCombining || !!mismatch}
                    >
                      <Layers className="w-4 h-4 mr-1" />
                      Combine {candidate.orderCount} Orders
                    </Button>
                  </div>

                  {/* Result message */}
                  {result && (
                    <div className={`mb-4 flex items-center gap-2 text-sm px-3 py-2 rounded-lg border ${
                      result.success
                        ? 'bg-green-50 text-green-700 border-green-200'
                        : 'bg-red-50 text-red-700 border-red-200'
                    }`}>
                      {result.success ? (
                        <CheckCircle className="w-4 h-4 flex-shrink-0" />
                      ) : (
                        <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      )}
                      <span>{result.message}</span>
                    </div>
                  )}

                  {/* Address Match Status */}
                  {!result && (
                    mismatch ? (
                      <div className="mb-4 flex items-center gap-2 text-sm bg-red-50 text-red-700 px-3 py-2 rounded-lg border border-red-200">
                        <AlertCircle className="w-4 h-4 flex-shrink-0" />
                        <span>Cannot combine: {mismatch}</span>
                      </div>
                    ) : (
                      <div className="mb-4 flex items-center gap-2 text-sm bg-green-50 text-green-700 px-3 py-2 rounded-lg border border-green-200">
                        <CheckCircle className="w-4 h-4 flex-shrink-0" />
                        <span>Shipping addresses match</span>
                      </div>
                    )
                  )}

                  <div className="grid gap-4 md:grid-cols-2">
                    {candidate.orders.map((order, idx) => (
                      <div
                        key={order.id}
                        className={`rounded-lg border p-4 ${idx === 0 ? 'bg-purple-50 border-purple-200' : 'bg-blue-50 border-blue-200'}`}
                      >
                        {/* Order Header */}
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <span className={`font-semibold ${idx === 0 ? 'text-purple-900' : 'text-blue-900'}`}>
                              #{order.externalId || order.label}
                            </span>
                            <Badge variant="warning" className="text-xs">
                              On Hold
                            </Badge>
                          </div>
                          <span className="text-xs text-gray-500">{formatDateFull(order.createdAt)}</span>
                        </div>

                        {/* Address */}
                        <div className={`text-xs mb-3 p-2 rounded ${idx === 0 ? 'bg-purple-100/50' : 'bg-blue-100/50'}`}>
                          <p className="font-medium text-gray-700 mb-1">Ship to:</p>
                          <p className="text-gray-600">
                            {order.address.first_name} {order.address.last_name}
                          </p>
                          <p className="text-gray-600">{order.address.address1}</p>
                          {order.address.address2 && (
                            <p className="text-gray-600">{order.address.address2}</p>
                          )}
                          <p className="text-gray-600">
                            {order.address.city}, {order.address.region} {order.address.zip}
                          </p>
                          <p className="text-gray-600">{order.address.country}</p>
                        </div>

                        {/* Items */}
                        <div>
                          <p className="font-medium text-gray-700 text-xs mb-2">
                            Items ({order.itemCount}):
                          </p>
                          <div className="space-y-1">
                            {order.items.map((item, itemIdx) => (
                              <div
                                key={itemIdx}
                                className={`text-xs py-1.5 px-2 rounded ${idx === 0 ? 'bg-purple-100/50' : 'bg-blue-100/50'}`}
                              >
                                <div className="flex justify-between">
                                  <span className="text-gray-700 truncate flex-1 mr-2">
                                    {item.title}
                                  </span>
                                  <span className="text-gray-500 flex-shrink-0">
                                    x{item.quantity}
                                  </span>
                                </div>
                                {item.variant && (
                                  <div className="text-gray-500 mt-0.5">
                                    {item.variant}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state when no combine candidates */}
      {(!data?.combineCandidates || data.combineCandidates.length === 0) && (
        <div className="bg-white rounded-lg border p-8 text-center">
          <Package className="w-12 h-12 text-gray-400 mx-auto mb-3" />
          <p className="text-gray-600">No orders ready to combine</p>
          <p className="text-sm text-gray-500 mt-1">
            Sync with Printify to check for customers with multiple orders on hold
          </p>
        </div>
      )}
    </div>
  );
}
