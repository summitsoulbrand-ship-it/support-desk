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
  deliveryStatus: string;
  carrier: string | null;
  trackingUrl: string | null;
  printifyUrl: string;
  shopifyUrl: string | null;
  replacement: { via: string; label: string } | null;
  refund: { label: string; amount: number } | null;
  manualSolved: boolean;
  note: string | null;
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
  const [tab, setTab] = useState<'open' | 'solved'>('open');

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
  // Solved = a reprint/replacement was sent, the customer was refunded, or the
  // operator manually marked it solved.
  const isSolved = (o: LateOrder) => !!o.replacement || !!o.refund || o.manualSolved;

  // Mark an order solved (with an optional note) or reopen it.
  const markSolved = async (o: LateOrder, solved: boolean) => {
    let note = o.note || '';
    if (solved) {
      const input = window.prompt('Note (optional) - e.g. "Printify refunded"', o.note || '');
      if (input === null) return; // cancelled
      note = input.trim();
    }
    queryClient.setQueryData<LateOrdersResponse>(['late-orders'], (prev) =>
      prev
        ? {
            ...prev,
            orders: prev.orders.map((x) =>
              x.printifyOrderId === o.printifyOrderId
                ? { ...x, manualSolved: solved, note: solved ? note || null : null }
                : x
            ),
          }
        : prev
    );
    await fetch('/api/late-orders/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printifyOrderId: o.printifyOrderId,
        solved,
        note: solved ? note : undefined,
      }),
    });
  };
  const solvedOrders = orders.filter(isSolved);
  const openOrders = orders.filter((o) => !isSolved(o));
  const visible = tab === 'solved' ? solvedOrders : openOrders;

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

      {!isLoading && orders.length > 0 && (
        <div className="mb-3 flex gap-1 border-b border-gray-200">
          {([
            ['open', 'Needs action', openOrders.length],
            ['solved', 'Solved', solvedOrders.length],
          ] as const).map(([key, label, n]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
                tab === key
                  ? 'border-rose-600 text-rose-700'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              {label} ({n})
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : orders.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center text-sm text-gray-500">
          Nothing is overdue. Every shipped order has been delivered within {threshold} days.
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center text-sm text-gray-500">
          {tab === 'open'
            ? 'Nothing unresolved - every late order has a reprint, replacement, or refund.'
            : 'No solved orders yet (none of the late orders have a reprint, replacement, or refund).'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Order</th>
                <th className="px-4 py-2 text-left font-medium">Days since ordered</th>
                <th className="px-4 py-2 text-left font-medium">Shipped</th>
                <th className="px-4 py-2 text-left font-medium">Delivery status</th>
                <th className="px-4 py-2 text-left font-medium">Resolution</th>
                <th className="px-4 py-2 text-left font-medium">Tracking</th>
                <th className="px-4 py-2 text-left font-medium">Escalate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visible.map((o) => (
                <tr key={o.printifyOrderId} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium">
                    {o.shopifyUrl ? (
                      <a
                        href={o.shopifyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-600 hover:text-indigo-800 hover:underline"
                      >
                        {o.orderName}
                      </a>
                    ) : (
                      <span className="text-gray-900">{o.orderName}</span>
                    )}
                  </td>
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
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                      {o.deliveryStatus || 'unknown'}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-col items-start gap-1">
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
                      {o.manualSolved && (
                        <span className="inline-flex w-fit items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-800">
                          <Check className="w-3 h-3" />
                          Marked solved
                        </span>
                      )}
                      {o.note && (
                        <span className="max-w-[200px] truncate text-xs text-gray-500" title={o.note}>
                          {o.note}
                        </span>
                      )}
                      {!o.replacement && !o.refund && !o.manualSolved && (
                        <span className="text-gray-400">-</span>
                      )}
                      <button
                        onClick={() => markSolved(o, !o.manualSolved)}
                        className="text-xs text-gray-500 underline hover:text-gray-800"
                      >
                        {o.manualSolved ? 'Reopen' : 'Mark solved'}
                      </button>
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
