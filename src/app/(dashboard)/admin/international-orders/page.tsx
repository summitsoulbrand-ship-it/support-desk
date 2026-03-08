'use client';

/**
 * International Orders - Manage Printify orders routed to domestic providers
 * but shipping to international addresses
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatDateFull } from '@/lib/utils';
import {
  Globe,
  RefreshCw,
  MapPin,
  AlertTriangle,
  CheckCircle,
  Package,
  ArrowRight,
} from 'lucide-react';

interface InternationalOrderItem {
  title: string;
  variant?: string;
  quantity: number;
  sku?: string;
  printProvider?: string;
}

interface InternationalOrder {
  id: string;
  printifyId: string;
  externalId?: string;
  label?: string;
  status: string;
  customerName: string;
  customerEmail?: string;
  country: string;
  address: {
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
  createdAt: string;
  itemCount: number;
  items: InternationalOrderItem[];
  printProviders: string[];
  canReroute: boolean;
  totalPrice: number;
}

interface InternationalOrdersData {
  orders: InternationalOrder[];
  byCountry: Record<string, InternationalOrder[]>;
  totalCount: number;
  countriesAffected: number;
}

function formatOrderNumber(orderNumber?: string): string {
  if (!orderNumber) return '#—';
  const cleaned = orderNumber.replace(/^#/, '');
  return `#${cleaned}`;
}

export default function InternationalOrdersPage() {
  const queryClient = useQueryClient();
  const [isSyncing, setIsSyncing] = useState(false);
  const [reroutingOrderId, setReroutingOrderId] = useState<string | null>(null);
  const [rerouteResult, setRerouteResult] = useState<{
    orderId: string;
    success: boolean;
    message: string;
  } | null>(null);

  // Sync with Printify when the page first loads - only fetch on-hold orders
  const { data: syncComplete, isLoading: isSyncingOnMount } = useQuery({
    queryKey: ['international-orders-initial-sync'],
    queryFn: async () => {
      await fetch('/api/admin/printify/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullSync: false, status: 'on-hold' }),
      });
      return true;
    },
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  const { data, isLoading, refetch, isFetching } = useQuery<InternationalOrdersData>({
    queryKey: ['international-orders'],
    queryFn: async () => {
      const res = await fetch('/api/admin/printify/international-orders');
      if (!res.ok) throw new Error('Failed to fetch orders');
      return res.json();
    },
    enabled: syncComplete === true,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      // Only sync on-hold orders for better performance
      await fetch('/api/admin/printify/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullSync: true, forceRefresh: true, status: 'on-hold' }),
      });
      await refetch();
    } finally {
      setIsSyncing(false);
    }
  };

  const handleRerouteOrder = async (order: InternationalOrder) => {
    setReroutingOrderId(order.id);
    setRerouteResult(null);

    try {
      const res = await fetch('/api/admin/printify/reroute-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: order.id }),
      });

      const result = await res.json();

      if (!res.ok) {
        setRerouteResult({
          orderId: order.id,
          success: false,
          message: result.error || 'Failed to reroute order',
        });
        return;
      }

      setRerouteResult({
        orderId: order.id,
        success: true,
        message: `Order rerouted successfully. New order: ${result.newOrderLabel || result.newOrderId}`,
      });

      // Trigger sync and refresh - only on-hold orders
      await fetch('/api/admin/printify/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullSync: false, status: 'on-hold' }),
      });
      await refetch();
      queryClient.invalidateQueries({ queryKey: ['printify-insights'] });
    } catch (err) {
      setRerouteResult({
        orderId: order.id,
        success: false,
        message: err instanceof Error ? err.message : 'Failed to reroute order',
      });
    } finally {
      setReroutingOrderId(null);
    }
  };

  if (isLoading || isSyncingOnMount) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-6">
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <p className="text-sm text-gray-500">Syncing with Printify...</p>
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
          <h1 className="text-2xl font-bold text-gray-900">International Orders</h1>
          <p className="text-sm text-gray-600 mt-1">
            Orders shipping internationally but routed to domestic US print providers
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
        <div className="bg-orange-50 rounded-lg border border-orange-200 p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-orange-100 text-orange-600 flex items-center justify-center">
              <Globe className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm text-orange-700">International Orders</p>
              <p className="text-2xl font-semibold text-orange-900">
                {data?.totalCount || 0}
              </p>
            </div>
          </div>
        </div>
        <div className="bg-blue-50 rounded-lg border border-blue-200 p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center">
              <MapPin className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm text-blue-700">Countries Affected</p>
              <p className="text-2xl font-semibold text-blue-900">
                {data?.countriesAffected || 0}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Explanation */}
      <div className="bg-yellow-50 rounded-lg border border-yellow-200 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-yellow-800">Why reroute orders?</p>
            <p className="text-sm text-yellow-700 mt-1">
              These orders are shipping to international addresses but Printify assigned them to
              domestic US print providers. Rerouting will cancel the order and recreate it,
              allowing Printify to select a print provider closer to the destination country
              for faster delivery and lower shipping costs.
            </p>
          </div>
        </div>
      </div>

      {/* Orders by Country */}
      {data?.byCountry && Object.keys(data.byCountry).length > 0 ? (
        <div className="space-y-6">
          {Object.entries(data.byCountry)
            .sort((a, b) => b[1].length - a[1].length)
            .map(([country, orders]) => (
              <div key={country} className="bg-white rounded-lg border p-5">
                <div className="flex items-center gap-2 mb-4">
                  <Globe className="w-5 h-5 text-blue-500" />
                  <h2 className="text-lg font-semibold text-gray-900">
                    {country}
                  </h2>
                  <Badge variant="default" className="ml-2">
                    {orders.length} order{orders.length !== 1 ? 's' : ''}
                  </Badge>
                </div>

                <div className="space-y-4">
                  {orders.map((order) => {
                    const isRerouting = reroutingOrderId === order.id;
                    const result = rerouteResult?.orderId === order.id ? rerouteResult : null;

                    return (
                      <div
                        key={order.id}
                        className="rounded-lg border p-4 bg-gray-50"
                      >
                        {/* Order Header */}
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <span className="font-semibold text-gray-900">
                              {formatOrderNumber(order.externalId || order.label)}
                            </span>
                            <Badge variant="warning" className="text-xs">
                              On Hold
                            </Badge>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-xs text-gray-500">
                              {formatDateFull(order.createdAt)}
                            </span>
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => handleRerouteOrder(order)}
                              loading={isRerouting}
                              disabled={isRerouting || !order.canReroute}
                            >
                              <ArrowRight className="w-4 h-4 mr-1" />
                              Reroute
                            </Button>
                          </div>
                        </div>

                        {/* Result message */}
                        {result && (
                          <div
                            className={`mb-3 flex items-center gap-2 text-sm px-3 py-2 rounded-lg border ${
                              result.success
                                ? 'bg-green-50 text-green-700 border-green-200'
                                : 'bg-red-50 text-red-700 border-red-200'
                            }`}
                          >
                            {result.success ? (
                              <CheckCircle className="w-4 h-4 flex-shrink-0" />
                            ) : (
                              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                            )}
                            <span>{result.message}</span>
                          </div>
                        )}

                        {/* Customer and Address */}
                        <div className="grid grid-cols-2 gap-4 mb-3">
                          <div>
                            <p className="text-xs font-medium text-gray-500 mb-1">Customer</p>
                            <p className="text-sm text-gray-900">{order.customerName}</p>
                            {order.customerEmail && (
                              <p className="text-xs text-gray-600">{order.customerEmail}</p>
                            )}
                          </div>
                          <div>
                            <p className="text-xs font-medium text-gray-500 mb-1">Ship to</p>
                            <p className="text-sm text-gray-900">
                              {order.address.city}, {order.address.region}
                            </p>
                            <p className="text-xs text-gray-600">{order.country}</p>
                          </div>
                        </div>

                        {/* Print Providers - Warning */}
                        <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 mb-3">
                          <p className="text-xs font-medium text-orange-700 mb-1">
                            Current Print Provider{order.printProviders.length > 1 ? 's' : ''}:
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {order.printProviders.map((provider, idx) => (
                              <Badge key={idx} variant="warning" className="text-xs">
                                {provider}
                              </Badge>
                            ))}
                          </div>
                          <p className="text-xs text-orange-600 mt-2">
                            US-based provider for international shipping
                          </p>
                        </div>

                        {/* Items */}
                        <div>
                          <p className="text-xs font-medium text-gray-500 mb-2">
                            Items ({order.itemCount}):
                          </p>
                          <div className="space-y-1">
                            {order.items.map((item, idx) => (
                              <div
                                key={idx}
                                className="text-xs py-1.5 px-2 rounded bg-white border"
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
                                  <div className="text-gray-500 mt-0.5">{item.variant}</div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>
      ) : (
        <div className="bg-white rounded-lg border p-8 text-center">
          <Package className="w-12 h-12 text-gray-400 mx-auto mb-3" />
          <p className="text-gray-600">No international routing issues found</p>
          <p className="text-sm text-gray-500 mt-1">
            All international orders are properly routed to international print providers
          </p>
        </div>
      )}
    </div>
  );
}
