'use client';

/**
 * Orders On Hold - Manage Printify orders on hold for combining
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { formatDateFull } from '@/lib/utils';
import {
  Package,
  RefreshCw,
  ExternalLink,
  Layers,
  AlertCircle,
  CheckCircle,
  Search,
  X,
  Loader2,
  AlertTriangle,
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

interface SearchResult {
  id: string;
  printifyId: string;
  externalId?: string;
  label?: string;
  status: string;
  customerName: string;
  customerEmail?: string;
  createdAt: string;
  itemCount: number;
  canCancel: boolean;
  address: PrintifyAddress;
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

  // Combine orders state
  const [combineModalOpen, setCombineModalOpen] = useState(false);
  const [selectedOrders, setSelectedOrders] = useState<OrderOnHold[]>([]);
  const [searchQuery1, setSearchQuery1] = useState('');
  const [searchQuery2, setSearchQuery2] = useState('');
  const [searchResults1, setSearchResults1] = useState<SearchResult[]>([]);
  const [searchResults2, setSearchResults2] = useState<SearchResult[]>([]);
  const [searching1, setSearching1] = useState(false);
  const [searching2, setSearching2] = useState(false);
  const [combiningOrders, setCombiningOrders] = useState(false);
  const [combineError, setCombineError] = useState<string | null>(null);
  const [combineSuccess, setCombineSuccess] = useState<string | null>(null);

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

  const searchOrders = async (query: string, setResults: (r: SearchResult[]) => void, setLoading: (l: boolean) => void) => {
    if (query.length < 2) {
      setResults([]);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/admin/printify/combine-orders?q=${encodeURIComponent(query)}`);
      if (res.ok) {
        const data = await res.json();
        setResults(data.orders || []);
      }
    } catch (err) {
      console.error('Search error:', err);
    } finally {
      setLoading(false);
    }
  };

  const selectOrder = (order: SearchResult, slot: 1 | 2) => {
    const orderOnHold: OrderOnHold = {
      ...order,
      items: [],
      totalPrice: 0,
    };

    if (slot === 1) {
      setSelectedOrders((prev) => [orderOnHold, prev[1]].filter(Boolean) as OrderOnHold[]);
      setSearchQuery1('');
      setSearchResults1([]);
    } else {
      setSelectedOrders((prev) => [prev[0], orderOnHold].filter(Boolean) as OrderOnHold[]);
      setSearchQuery2('');
      setSearchResults2([]);
    }
  };

  const removeOrder = (slot: 1 | 2) => {
    if (slot === 1) {
      setSelectedOrders((prev) => prev.slice(1));
    } else {
      setSelectedOrders((prev) => [prev[0]].filter(Boolean));
    }
  };

  const openCombineModal = (orders?: OrderOnHold[]) => {
    setCombineModalOpen(true);
    setCombineError(null);
    setCombineSuccess(null);
    if (orders && orders.length >= 2) {
      setSelectedOrders(orders.slice(0, 2));
    } else {
      setSelectedOrders([]);
    }
  };

  const closeCombineModal = () => {
    setCombineModalOpen(false);
    setSelectedOrders([]);
    setSearchQuery1('');
    setSearchQuery2('');
    setSearchResults1([]);
    setSearchResults2([]);
    setCombineError(null);
    setCombineSuccess(null);
  };

  const handleCombineOrders = async () => {
    if (selectedOrders.length !== 2) {
      setCombineError('Please select exactly 2 orders to combine');
      return;
    }

    const order1 = selectedOrders[0];
    const order2 = selectedOrders[1];

    if (!order1.canCancel) {
      setCombineError(`Order ${order1.externalId || order1.label} is already in production and cannot be combined`);
      return;
    }

    if (!order2.canCancel) {
      setCombineError(`Order ${order2.externalId || order2.label} is already in production and cannot be combined`);
      return;
    }

    setCombiningOrders(true);
    setCombineError(null);
    setCombineSuccess(null);

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
        setCombineError(result.error || 'Failed to combine orders');
        return;
      }

      setCombineSuccess(`Orders combined successfully! New order: ${result.combinedOrderLabel}`);

      // Refresh the orders list
      await refetch();
      queryClient.invalidateQueries({ queryKey: ['printify-insights'] });

      // Close modal after a short delay
      setTimeout(() => {
        closeCombineModal();
      }, 2000);
    } catch (err) {
      setCombineError(err instanceof Error ? err.message : 'Failed to combine orders');
    } finally {
      setCombiningOrders(false);
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
          <h1 className="text-2xl font-bold text-gray-900">Orders On Hold</h1>
          <p className="text-sm text-gray-600 mt-1">
            Manage Printify orders on hold - combine multiple orders from the same customer
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            onClick={() => openCombineModal()}
          >
            <Layers className="w-4 h-4 mr-1" />
            Combine Orders
          </Button>
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
              <p className="text-sm text-purple-700">Customers with Multiple Orders</p>
              <p className="text-2xl font-semibold text-purple-900">{data?.customersWithMultiple || 0}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Combine Candidates - Customers with Multiple Orders */}
      {data?.combineCandidates && data.combineCandidates.length > 0 && (
        <div className="bg-purple-50 rounded-lg border border-purple-200 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Layers className="w-5 h-5 text-purple-500" />
            <h2 className="text-lg font-semibold text-gray-900">
              Ready to Combine ({data.combineCandidates.length} customers)
            </h2>
          </div>

          <div className="space-y-6">
            {data.combineCandidates.map((candidate) => (
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
                    onClick={() => openCombineModal(candidate.orders)}
                  >
                    <Layers className="w-4 h-4 mr-1" />
                    Combine {candidate.orderCount} Orders
                  </Button>
                </div>

                {/* Address Match Status */}
                {candidate.orders.length >= 2 && (() => {
                  const mismatch = checkAddressMatch(candidate.orders[0].address, candidate.orders[1].address);
                  return mismatch ? (
                    <div className="mb-4 flex items-center gap-2 text-sm bg-red-50 text-red-700 px-3 py-2 rounded-lg border border-red-200">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      <span>Addresses do not match: {mismatch}</span>
                    </div>
                  ) : (
                    <div className="mb-4 flex items-center gap-2 text-sm bg-green-50 text-green-700 px-3 py-2 rounded-lg border border-green-200">
                      <CheckCircle className="w-4 h-4 flex-shrink-0" />
                      <span>Shipping addresses match</span>
                    </div>
                  );
                })()}

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
                          <Badge variant={order.canCancel ? 'warning' : 'error'} className="text-xs">
                            {order.canCancel ? 'On Hold' : 'In Production'}
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
                              className={`text-xs py-1 px-2 rounded flex justify-between ${idx === 0 ? 'bg-purple-100/50' : 'bg-blue-100/50'}`}
                            >
                              <span className="text-gray-700 truncate flex-1 mr-2">
                                {item.title}
                              </span>
                              <span className="text-gray-500 flex-shrink-0">
                                x{item.quantity}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* All Orders On Hold */}
      {data?.orders && data.orders.length > 0 ? (
        <div className="bg-white rounded-lg border">
          <div className="px-5 py-4 border-b">
            <h2 className="text-lg font-semibold text-gray-900">
              All Orders On Hold ({data.orders.length})
            </h2>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left py-3 px-4 font-medium text-gray-600">Order</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-600">Customer</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-600">Items</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-600">Status</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-600">Created</th>
                  <th className="text-right py-3 px-4 font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((order) => (
                  <tr key={order.id} className="border-b hover:bg-gray-50">
                    <td className="py-3 px-4">
                      <span className="font-medium text-gray-900">
                        #{order.externalId || order.label || order.id.slice(0, 8)}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <div>
                        <p className="text-gray-900">{order.customerName}</p>
                        <p className="text-xs text-gray-500">{order.customerEmail}</p>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-gray-600">{order.itemCount} items</td>
                    <td className="py-3 px-4">
                      <Badge variant={order.canCancel ? 'warning' : 'error'}>
                        {order.canCancel ? 'On Hold' : 'In Production'}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 text-gray-600">{formatDateFull(order.createdAt)}</td>
                    <td className="py-3 px-4 text-right">
                      <a
                        href={`https://printify.com/app/order/${order.printifyId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-purple-600 hover:text-purple-800"
                      >
                        View <ExternalLink className="w-3 h-3" />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-lg border p-8 text-center">
          <Package className="w-12 h-12 text-gray-400 mx-auto mb-3" />
          <p className="text-gray-600">No orders on hold</p>
          <p className="text-sm text-gray-500 mt-1">
            Sync with Printify to check for orders on hold
          </p>
        </div>
      )}

      {/* Combine Orders Modal */}
      {combineModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl max-h-[90vh] flex flex-col">
            <div className="px-6 py-4 border-b flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Combine Orders</h3>
                <p className="text-sm text-gray-600">
                  Select two orders to combine into one
                </p>
              </div>
              <button
                onClick={closeCombineModal}
                className="p-2 hover:bg-gray-100 rounded-lg"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <div className="p-6 space-y-6 overflow-y-auto">
              {/* Error/Success Messages */}
              {combineError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-700">{combineError}</p>
                </div>
              )}

              {combineSuccess && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-start gap-3">
                  <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-green-700">{combineSuccess}</p>
                </div>
              )}

              {/* Order 1 Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Order 1 (Primary - will be used for the combined order name)
                </label>
                {selectedOrders[0] ? (
                  <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 flex items-center justify-between">
                    <div>
                      <p className="font-medium text-purple-900">
                        #{selectedOrders[0].externalId || selectedOrders[0].label}
                      </p>
                      <p className="text-sm text-purple-700">{selectedOrders[0].customerName}</p>
                      <p className="text-xs text-purple-600">{selectedOrders[0].itemCount} items</p>
                    </div>
                    <button
                      onClick={() => removeOrder(1)}
                      className="p-2 hover:bg-purple-100 rounded"
                    >
                      <X className="w-4 h-4 text-purple-500" />
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <div className="absolute left-3 top-1/2 -translate-y-1/2">
                      {searching1 ? (
                        <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />
                      ) : (
                        <Search className="w-4 h-4 text-gray-400" />
                      )}
                    </div>
                    <Input
                      type="text"
                      placeholder="Search by order number or customer name..."
                      value={searchQuery1}
                      onChange={(e) => {
                        setSearchQuery1(e.target.value);
                        searchOrders(e.target.value, setSearchResults1, setSearching1);
                      }}
                      className="pl-10"
                    />
                    {searchResults1.length > 0 && (
                      <div className="absolute z-10 w-full mt-1 bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                        {searchResults1.map((order) => (
                          <button
                            key={order.id}
                            onClick={() => selectOrder(order, 1)}
                            className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b last:border-b-0"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-medium">#{order.externalId || order.label}</span>
                              <Badge variant={order.canCancel ? 'warning' : 'error'} className="text-xs">
                                {order.canCancel ? 'Can Combine' : 'In Production'}
                              </Badge>
                            </div>
                            <p className="text-sm text-gray-600">{order.customerName}</p>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Order 2 Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Order 2 (Will be merged into Order 1)
                </label>
                {selectedOrders[1] ? (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center justify-between">
                    <div>
                      <p className="font-medium text-blue-900">
                        #{selectedOrders[1].externalId || selectedOrders[1].label}
                      </p>
                      <p className="text-sm text-blue-700">{selectedOrders[1].customerName}</p>
                      <p className="text-xs text-blue-600">{selectedOrders[1].itemCount} items</p>
                    </div>
                    <button
                      onClick={() => removeOrder(2)}
                      className="p-2 hover:bg-blue-100 rounded"
                    >
                      <X className="w-4 h-4 text-blue-500" />
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <div className="absolute left-3 top-1/2 -translate-y-1/2">
                      {searching2 ? (
                        <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />
                      ) : (
                        <Search className="w-4 h-4 text-gray-400" />
                      )}
                    </div>
                    <Input
                      type="text"
                      placeholder="Search by order number or customer name..."
                      value={searchQuery2}
                      onChange={(e) => {
                        setSearchQuery2(e.target.value);
                        searchOrders(e.target.value, setSearchResults2, setSearching2);
                      }}
                      className="pl-10"
                    />
                    {searchResults2.length > 0 && (
                      <div className="absolute z-10 w-full mt-1 bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                        {searchResults2.map((order) => (
                          <button
                            key={order.id}
                            onClick={() => selectOrder(order, 2)}
                            className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b last:border-b-0"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-medium">#{order.externalId || order.label}</span>
                              <Badge variant={order.canCancel ? 'warning' : 'error'} className="text-xs">
                                {order.canCancel ? 'Can Combine' : 'In Production'}
                              </Badge>
                            </div>
                            <p className="text-sm text-gray-600">{order.customerName}</p>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Address Validation Warning */}
              {selectedOrders.length === 2 && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                    <div className="text-sm text-amber-700">
                      <p className="font-medium mb-1">Before combining:</p>
                      <ul className="list-disc list-inside space-y-1">
                        <li>Shipping addresses must match exactly</li>
                        <li>Both orders must not be in production yet</li>
                        <li>The combined order will use Order 1&apos;s name</li>
                        <li>Both original orders will be cancelled in Printify</li>
                        <li>Customer will receive a shipping notification</li>
                      </ul>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t flex items-center justify-end gap-3">
              <Button
                variant="secondary"
                onClick={closeCombineModal}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleCombineOrders}
                loading={combiningOrders}
                disabled={selectedOrders.length !== 2 || combiningOrders}
              >
                <Layers className="w-4 h-4 mr-1" />
                Combine Orders
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
