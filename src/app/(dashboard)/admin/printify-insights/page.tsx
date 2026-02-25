'use client';

/**
 * Printify Insights - Analytics dashboard for order fulfillment
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatDateFull } from '@/lib/utils';
import {
  Package,
  TrendingUp,
  Clock,
  Truck,
  AlertTriangle,
  Calendar,
  RefreshCw,
  ExternalLink,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  PieChart,
  Pie,
  Cell,
} from 'recharts';

type TimeMetrics = {
  avgQueueTime: number | null;
  avgProductionTime: number | null;
  avgFulfillmentDelay: number | null;
  avgTransitTime: number | null;
  avgTotalTime: number | null;
};

type ProviderStats = {
  providerId: number;
  orderCount: number;
  avgProductionTime: number | null;
  avgTotalTime: number | null;
};

type DelayedOrder = {
  id: string;
  appOrderId: string | null;
  externalId: string | null;
  status: string;
  createdAt: string;
  daysOld: number;
  delayReason: string;
  lastUpdate: string | null;
  isRefunded: boolean;
  isReturned: boolean;
};

type DeliveredOrder = {
  id: string;
  appOrderId: string | null;
  externalId: string | null;
  fulfilledAt: string;
  deliveredAt: string;
  deliveryDays: number; // fulfilled_at -> delivered_at
  isReturned: boolean;
};

type DailyMetric = {
  date: string;
  ordersCreated: number;
  ordersShipped: number;
  ordersDelivered: number;
  avgProductionDays: number | null;
};

type InsightsData = {
  shopId: string | null;
  range: { start: string; end: string };
  summary: {
    totalOrders: number;
    deliveredOrders: number;
    inTransitOrders: number;
    inProductionOrders: number;
    deliveryRate: number;
    avgProductionTime: number | null;
    avgDeliveredIn: number | null;
  };
  timeMetrics: TimeMetrics;
  providerStats: ProviderStats[];
  delayedOrders: DelayedOrder[];
  recentlyDeliveredOrders: DeliveredOrder[];
  dailyMetrics: DailyMetric[];
};

const COLORS = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#6366f1'];

const DATE_PRESETS = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 6 months', days: 180 },
  { label: 'Last year', days: 365 },
];

function formatDays(value: number | null): string {
  if (value === null) return '-';
  return `${value.toFixed(1)} days`;
}

function StatCard({
  icon: Icon,
  label,
  value,
  subtext,
  color = 'purple',
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  subtext?: string;
  color?: 'purple' | 'blue' | 'green' | 'amber' | 'red';
}) {
  const colorClasses = {
    purple: 'bg-purple-100 text-purple-600',
    blue: 'bg-blue-100 text-blue-600',
    green: 'bg-green-100 text-green-600',
    amber: 'bg-amber-100 text-amber-600',
    red: 'bg-red-100 text-red-600',
  };

  return (
    <div className="bg-white rounded-lg border p-4">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-lg ${colorClasses[color]} flex items-center justify-center`}>
          <Icon className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-600">{label}</p>
          <p className="text-xl font-semibold text-gray-900">{value}</p>
          {subtext && <p className="text-xs text-gray-500">{subtext}</p>}
        </div>
      </div>
    </div>
  );
}

export default function PrintifyInsightsPage() {
  const [dateRange, setDateRange] = useState(30);
  const [showAllDelayed, setShowAllDelayed] = useState(false);

  const [isSyncing, setIsSyncing] = useState(false);

  const startDate = new Date(Date.now() - dateRange * 24 * 60 * 60 * 1000).toISOString();
  const endDate = new Date().toISOString();

  const { data, isLoading, refetch, isFetching } = useQuery<InsightsData>({
    queryKey: ['printify-insights', dateRange],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/printify/insights?start=${startDate}&end=${endDate}`
      );
      if (!res.ok) throw new Error('Failed to fetch insights');
      return res.json();
    },
  });

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      // Sync from Printify API - use fullSync to check all pages for updates
      await fetch('/api/admin/printify/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullSync: true }),
      });
      // Then refetch insights
      await refetch();
    } finally {
      setIsSyncing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-6">
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <div className="grid grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-24 bg-gray-200 rounded" />
            ))}
          </div>
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6">
        <p className="text-gray-600">No data available. Sync your Printify orders first.</p>
      </div>
    );
  }

  const { shopId, summary, timeMetrics, providerStats, delayedOrders, recentlyDeliveredOrders, dailyMetrics } = data;

  // Prepare chart data
  const timeBreakdownData = [
    { name: 'Queue', value: timeMetrics.avgQueueTime || 0 },
    { name: 'Production', value: timeMetrics.avgProductionTime || 0 },
    { name: 'Fulfillment', value: timeMetrics.avgFulfillmentDelay || 0 },
    { name: 'Transit', value: timeMetrics.avgTransitTime || 0 },
  ].filter((d) => d.value > 0);

  const displayedDelayed = showAllDelayed ? delayedOrders : delayedOrders.slice(0, 5);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Printify Insights</h1>
          <p className="text-sm text-gray-600 mt-1">
            Order fulfillment analytics and performance metrics
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-white border rounded-lg p-1">
            {DATE_PRESETS.map((preset) => (
              <button
                key={preset.days}
                onClick={() => setDateRange(preset.days)}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                  dateRange === preset.days
                    ? 'bg-purple-100 text-purple-700 font-medium'
                    : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                {preset.label}
              </button>
            ))}
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
      </div>

      {/* Delayed Orders - Priority Section */}
      {delayedOrders.length > 0 && (
        <div className="bg-amber-50 rounded-lg border border-amber-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              <h2 className="text-lg font-semibold text-gray-900">
                Delayed Orders ({delayedOrders.length})
              </h2>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-amber-200">
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Order</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Status</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Created</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Age</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Reason</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody>
                {displayedDelayed.map((order) => (
                  <tr key={order.id} className="border-b border-amber-100 hover:bg-amber-100/50">
                    <td className="py-3 px-3">
                      <div>
                        <span className="font-medium text-gray-900">
                          #{order.appOrderId || order.id.slice(0, 8)}
                        </span>
                        {order.externalId && (
                          <span className="text-xs text-gray-500 block">
                            Ref: {order.externalId}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Badge
                          variant={
                            order.status === 'pending'
                              ? 'warning'
                              : order.status === 'on-hold'
                              ? 'warning'
                              : 'info'
                          }
                        >
                          {order.status}
                        </Badge>
                        {order.isReturned && (
                          <Badge variant="error">Returned</Badge>
                        )}
                        {order.isRefunded && (
                          <Badge variant="error">Refunded</Badge>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-3 text-gray-600">
                      {formatDateFull(order.createdAt)}
                    </td>
                    <td className="py-3 px-3">
                      <span className="font-medium text-red-600">{order.daysOld} days</span>
                    </td>
                    <td className="py-3 px-3 text-gray-700">{order.delayReason}</td>
                    <td className="py-3 px-3 text-right">
                      <a
                        href={shopId
                          ? `https://printify.com/app/store/${shopId}/order/${order.id}`
                          : `https://printify.com/app/order/${order.id}`
                        }
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

          {delayedOrders.length > 5 && (
            <button
              onClick={() => setShowAllDelayed(!showAllDelayed)}
              className="mt-4 flex items-center gap-1 text-sm text-amber-700 hover:text-amber-900"
            >
              {showAllDelayed ? (
                <>
                  Show less <ChevronUp className="w-4 h-4" />
                </>
              ) : (
                <>
                  Show all {delayedOrders.length} delayed orders <ChevronDown className="w-4 h-4" />
                </>
              )}
            </button>
          )}
        </div>
      )}

      {/* Recently Delivered Orders */}
      {recentlyDeliveredOrders.length > 0 && (
        <div className="bg-white rounded-lg border p-5">
          <div className="flex items-center gap-2 mb-4">
            <Truck className="w-5 h-5 text-green-500" />
            <h2 className="text-lg font-semibold text-gray-900">
              Recently Delivered ({recentlyDeliveredOrders.length})
            </h2>
            {summary.avgDeliveredIn !== null && (
              <span className="ml-auto text-sm text-gray-500">
                Avg. {summary.avgDeliveredIn.toFixed(1)} days to deliver
              </span>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Order</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Fulfilled</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Delivered</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Delivery Time</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody>
                {recentlyDeliveredOrders.map((order) => (
                  <tr key={order.id} className="border-b hover:bg-gray-50">
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900">
                          #{order.appOrderId || order.id.slice(0, 8)}
                        </span>
                        {order.isReturned && (
                          <Badge variant="error">Returned</Badge>
                        )}
                      </div>
                      {order.externalId && (
                        <span className="text-xs text-gray-500 block">
                          Ref: {order.externalId}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-gray-600">
                      {formatDateFull(order.fulfilledAt)}
                    </td>
                    <td className="py-3 px-3 text-gray-600">
                      {formatDateFull(order.deliveredAt)}
                    </td>
                    <td className="py-3 px-3">
                      <span className={order.deliveryDays > 10 ? 'text-amber-600 font-medium' : 'text-green-600 font-medium'}>
                        {order.deliveryDays} days
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right">
                      <a
                        href={shopId
                          ? `https://printify.com/app/store/${shopId}/order/${order.id}`
                          : `https://printify.com/app/order/${order.id}`
                        }
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
      )}

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard
          icon={Package}
          label="Total Orders"
          value={summary.totalOrders}
          subtext={`In selected period`}
          color="purple"
        />
        <StatCard
          icon={Truck}
          label="Delivered"
          value={summary.deliveredOrders}
          subtext={`${(summary.deliveryRate * 100).toFixed(0)}% delivery rate`}
          color="green"
        />
        <StatCard
          icon={Clock}
          label="In Transit"
          value={summary.inTransitOrders}
          color="blue"
        />
        <StatCard
          icon={TrendingUp}
          label="In Production"
          value={summary.inProductionOrders}
          color="amber"
        />
        <StatCard
          icon={Clock}
          label="Production Time"
          value={summary.avgProductionTime !== null ? summary.avgProductionTime.toFixed(1) : '-'}
          subtext="Created → fulfilled (days)"
          color="blue"
        />
        <StatCard
          icon={Truck}
          label="Delivered In"
          value={summary.avgDeliveredIn !== null ? summary.avgDeliveredIn.toFixed(1) : '-'}
          subtext="Fulfilled → delivered (days)"
          color="green"
        />
      </div>

      {/* Time Metrics */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Average Times */}
        <div className="bg-white rounded-lg border p-5">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Average Fulfillment Times</h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between py-2 border-b">
              <span className="text-gray-600">Queue Time</span>
              <span className="font-medium text-gray-900">{formatDays(timeMetrics.avgQueueTime)}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b">
              <span className="text-gray-600">Production Time</span>
              <span className="font-medium text-gray-900">{formatDays(timeMetrics.avgProductionTime)}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b">
              <span className="text-gray-600">Fulfillment Delay</span>
              <span className="font-medium text-gray-900">{formatDays(timeMetrics.avgFulfillmentDelay)}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b">
              <span className="text-gray-600">Transit Time</span>
              <span className="font-medium text-gray-900">{formatDays(timeMetrics.avgTransitTime)}</span>
            </div>
            <div className="flex items-center justify-between py-2 bg-purple-50 rounded px-2 -mx-2">
              <span className="font-medium text-purple-800">Total Time (Order to Delivery)</span>
              <span className="font-bold text-purple-900">{formatDays(timeMetrics.avgTotalTime)}</span>
            </div>
          </div>
        </div>

        {/* Time Breakdown Pie Chart */}
        <div className="bg-white rounded-lg border p-5">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Time Breakdown</h2>
          {timeBreakdownData.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie
                  data={timeBreakdownData}
                  cx="50%"
                  cy="50%"
                  outerRadius={80}
                  dataKey="value"
                  label={({ name, value }) => `${name}: ${value.toFixed(1)}d`}
                >
                  {timeBreakdownData.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => `${Number(value).toFixed(1)} days`} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-64 flex items-center justify-center text-gray-500">
              Not enough data for breakdown
            </div>
          )}
        </div>
      </div>

      {/* Daily Trends */}
      <div className="bg-white rounded-lg border p-5">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Daily Order Volume</h2>
        {dailyMetrics.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={dailyMetrics}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                dataKey="date"
                tickFormatter={(date) => new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                stroke="#6b7280"
                fontSize={12}
              />
              <YAxis stroke="#6b7280" fontSize={12} />
              <Tooltip
                labelFormatter={(date) => new Date(date).toLocaleDateString()}
                contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="ordersCreated"
                name="Created"
                stroke="#8b5cf6"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="ordersShipped"
                name="Shipped"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="ordersDelivered"
                name="Delivered"
                stroke="#10b981"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-64 flex items-center justify-center text-gray-500">
            No daily data available
          </div>
        )}
      </div>

      {/* Provider Performance */}
      {providerStats.length > 0 && (
        <div className="bg-white rounded-lg border p-5">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Print Provider Performance</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={providerStats} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis type="number" stroke="#6b7280" fontSize={12} />
              <YAxis
                type="category"
                dataKey="providerId"
                stroke="#6b7280"
                fontSize={12}
                tickFormatter={(id) => `Provider ${id}`}
                width={100}
              />
              <Tooltip
                contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }}
                formatter={(value, name) => [
                  name === 'avgProductionTime' ? `${Number(value).toFixed(1)} days` : value,
                  name === 'avgProductionTime' ? 'Avg Production Time' : 'Order Count',
                ]}
              />
              <Legend />
              <Bar dataKey="orderCount" name="Order Count" fill="#8b5cf6" />
              <Bar dataKey="avgProductionTime" name="Avg Production (days)" fill="#3b82f6" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

    </div>
  );
}
