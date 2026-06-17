'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Clock, RefreshCcw, ExternalLink, Flag, Truck, Check, DollarSign } from 'lucide-react';

interface LateOrder {
  printifyOrderId: string;
  orderName: string;
  daysSinceOrdered: number;
  daysSinceShipped: number | null;
  status: string;
  carrier: string | null;
  trackingUrl: string | null;
  printifyUrl: string;
  replacement: { via: string; label: string } | null;
  refund: { label: string; amount: number } | null;
}

interface LateOrdersResponse {
  thresholdDays: number;
  count: number;
  orders: LateOrder[];
  cached?: boolean;
  cachedAt?: string;
}

export default function LateOrdersPage() {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const { data, isLoading } = useQuery<LateOrdersResponse>({
    queryKey: ['late-orders'],
    queryFn: async () => {
      const res = await fetch('/api/late-orders');
      if (!res.ok) throw new Error('Failed to load late orders');
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  // Refresh forces a fresh live pull from Printify (bypasses the 30-min cache).
  const refreshFresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/late-orders?fresh=1');
      if (res.ok) queryClient.setQueryData(['late-orders'], await res.json());
    } finally {
      setRefreshing(false);
    }
  };

  const orders = data?.orders || [];
  const threshold = data?.thresholdDays || 13;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          <Clock className="w-5 h-5 text-rose-600" />
          Late deliveries
        </h1>
        <button
          onClick={refreshFresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 disabled:opacity-50"
        >
          <RefreshCcw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Pulling from Printify...' : 'Refresh'}
        </button>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Not delivered within {threshold} days of ordering, from the last 3 months (from Printify).{' '}
        {data ? `${data.count} order${data.count === 1 ? '' : 's'}.` : ''}
        {data?.cached ? ' Cached - hit Refresh to re-pull.' : ''}
      </p>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : orders.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center text-sm text-gray-500">
          Nothing is overdue. Every shipped order has been delivered within {threshold} days.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Order</th>
                <th className="px-4 py-2 text-left font-medium">Days since ordered</th>
                <th className="px-4 py-2 text-left font-medium">Shipped</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-left font-medium">Resolution</th>
                <th className="px-4 py-2 text-left font-medium">Tracking</th>
                <th className="px-4 py-2 text-left font-medium">Escalate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {orders.map((o) => (
                <tr key={o.printifyOrderId} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium text-gray-900">{o.orderName}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                        o.daysSinceOrdered >= 21
                          ? 'bg-rose-100 text-rose-800'
                          : o.daysSinceOrdered >= 17
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-yellow-50 text-yellow-700'
                      }`}
                    >
                      {o.daysSinceOrdered} days
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {o.daysSinceShipped !== null
                      ? `${o.daysSinceShipped}d ago`
                      : 'Not shipped'}
                  </td>
                  <td className="px-4 py-2 text-gray-700 capitalize">
                    {(o.status || '').replace(/[-_]/g, ' ')}
                    {o.carrier ? ` · ${o.carrier}` : ''}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-col gap-1">
                      {o.replacement && (
                        <span
                          className="inline-flex w-fit items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800"
                          title={o.replacement.via}
                        >
                          <Check className="w-3 h-3" />
                          {o.replacement.label}
                        </span>
                      )}
                      {o.refund && (
                        <span
                          className="inline-flex w-fit items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-800"
                          title={o.refund.amount ? `$${o.refund.amount.toFixed(2)} refunded` : undefined}
                        >
                          <DollarSign className="w-3 h-3" />
                          {o.refund.label}
                        </span>
                      )}
                      {!o.replacement && !o.refund && <span className="text-gray-400">-</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    {o.trackingUrl ? (
                      <a
                        href={o.trackingUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800"
                      >
                        <Truck className="w-4 h-4" />
                        Track
                      </a>
                    ) : (
                      <span className="text-gray-400">-</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <a
                      href={o.printifyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-rose-600 hover:text-rose-800"
                    >
                      <Flag className="w-4 h-4" />
                      Printify
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
