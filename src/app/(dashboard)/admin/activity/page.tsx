'use client';

/**
 * Admin Activity log - append-only record of money/order actions.
 */

import { useQuery } from '@tanstack/react-query';
import { formatDate } from '@/lib/utils';
import { DollarSign, XCircle, RefreshCcw, Tag, Package, Activity } from 'lucide-react';

interface ActionLogRow {
  id: string;
  threadId: string | null;
  userName: string;
  action: string;
  summary: string;
  amountCents: number | null;
  orderName: string | null;
  createdAt: string;
}

const ACTION_META: Record<string, { label: string; icon: typeof DollarSign; className: string }> = {
  refund: { label: 'Refund', icon: DollarSign, className: 'bg-red-100 text-red-700' },
  cancel_both: { label: 'Cancel + refund', icon: XCircle, className: 'bg-red-100 text-red-700' },
  cancel_shopify: { label: 'Cancel', icon: XCircle, className: 'bg-red-100 text-red-700' },
  create_replacement: { label: 'Replacement', icon: RefreshCcw, className: 'bg-indigo-100 text-indigo-700' },
  discount_adjustment: { label: 'Discount', icon: Tag, className: 'bg-amber-100 text-amber-800' },
  suppress_marketing: { label: 'Unsubscribe', icon: XCircle, className: 'bg-gray-100 text-gray-700' },
};

function fmtMoney(cents: number | null): string | null {
  if (cents == null) return null;
  return `$${(cents / 100).toFixed(2)}`;
}

export default function ActivityPage() {
  const { data, isLoading } = useQuery<{ logs: ActionLogRow[] }>({
    queryKey: ['activity-log'],
    queryFn: async () => {
      const res = await fetch('/api/admin/activity');
      if (!res.ok) throw new Error('Failed to load activity');
      return res.json();
    },
    refetchInterval: 60000,
  });

  const logs = data?.logs || [];

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 mb-1">
        <Activity className="w-5 h-5 text-gray-700" />
        <h1 className="text-xl font-semibold text-gray-900">Activity Log</h1>
      </div>
      <p className="text-sm text-gray-600 mb-5">
        Every refund, cancellation, replacement, and discount, with who did it.
        Read-only.
      </p>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : logs.length === 0 ? (
        <p className="text-sm text-gray-500">No actions logged yet.</p>
      ) : (
        <ul className="divide-y border rounded-lg bg-white">
          {logs.map((log) => {
            const meta = ACTION_META[log.action] || {
              label: log.action,
              icon: Package,
              className: 'bg-gray-100 text-gray-700',
            };
            const Icon = meta.icon;
            const money = fmtMoney(log.amountCents);
            return (
              <li key={log.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ${meta.className}`}>
                  <Icon className="w-3 h-3" />
                  {meta.label}
                </span>
                <span className="text-gray-900 flex-1 min-w-0 truncate">
                  {log.summary}
                  {log.orderName ? <span className="text-gray-500"> · {log.orderName}</span> : null}
                </span>
                {money && <span className="font-medium text-gray-900 flex-shrink-0">{money}</span>}
                <span className="text-gray-500 flex-shrink-0">{log.userName}</span>
                <span className="text-gray-400 flex-shrink-0 w-28 text-right">{formatDate(log.createdAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
