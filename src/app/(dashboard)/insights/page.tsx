'use client';

/**
 * Insights - what customers are contacting us about, review health, and
 * per-product replacement analysis, with previous-period trends.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { cn } from '@/lib/utils';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Mail,
  MessageCircle,
  Star,
  Repeat,
  AlertTriangle,
} from 'lucide-react';

const INTENT_LABELS: Record<string, string> = {
  SIZE_EXCHANGE: 'Size exchange',
  SHIPPING_STATUS: 'Shipping status',
  ADDRESS_UPDATE: 'Address update',
  CANCELLATION: 'Cancellation',
  OTHER: 'Other',
};

const INTENT_COLORS: Record<string, string> = {
  SIZE_EXCHANGE: '#8b5cf6',
  SHIPPING_STATUS: '#3b82f6',
  ADDRESS_UPDATE: '#f59e0b',
  CANCELLATION: '#ef4444',
  OTHER: '#9ca3af',
};

interface Insights {
  windowDays: number;
  generatedAt: string;
  emails: {
    intents: { intent: string; count: number; prevCount: number }[];
    upset: number;
    weekly: ({ week: string } & Record<string, number | string>)[];
    total: number;
  };
  reviews: {
    total: number;
    prevTotal: number;
    lowStar: number;
    avgRating: number;
    prevAvgRating: number;
    byRating: Record<number, number>;
  };
  social: { comments: number; prevComments: number; adComments: number };
  replacements: {
    total: number;
    prevTotal: number;
    reasons: { tooSmall: number; tooLarge: number; colorChange: number; other: number };
    perProduct: { title: string; unitsSold: number; replacements: number; rate: number }[];
  };
}

function Delta({ now, prev }: { now: number; prev: number }) {
  if (prev === 0 && now === 0) return <Minus className="w-3.5 h-3.5 text-gray-400" />;
  const diff = now - prev;
  if (diff === 0) return <Minus className="w-3.5 h-3.5 text-gray-400" />;
  const up = diff > 0;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-xs', up ? 'text-red-600' : 'text-emerald-600')}>
      {up ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
      {up ? '+' : ''}
      {diff}
    </span>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div className="bg-white border rounded-lg p-4">
      <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
        <Icon className="w-4 h-4" />
        {label}
      </div>
      <div className="text-2xl font-semibold text-gray-900">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

export default function InsightsPage() {
  const [days, setDays] = useState<14 | 30>(30);

  const { data, isLoading } = useQuery<Insights>({
    queryKey: ['insights', days],
    queryFn: async () => {
      const res = await fetch(`/api/insights/support?days=${days}`);
      if (!res.ok) throw new Error('Failed to load insights');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const totalIntents = data?.emails.intents.reduce((s, i) => s + i.count, 0) || 0;
  const sortedIntents = [...(data?.emails.intents || [])].sort((a, b) => b.count - a.count);
  const reasons = data?.replacements.reasons;
  const reasonsTotal = reasons
    ? reasons.tooSmall + reasons.tooLarge + reasons.colorChange + reasons.other
    : 0;

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Insights</h1>
          <p className="text-sm text-gray-500 mt-1">
            What customers contact us about, and which products come back
          </p>
        </div>
        <div className="flex gap-1">
          {([14, 30] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={cn(
                'px-3 py-1.5 text-sm rounded-lg border',
                days === d
                  ? 'bg-blue-100 border-blue-300 text-blue-700 font-medium'
                  : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
              )}
            >
              Last {d} days
            </button>
          ))}
        </div>
      </div>

      {isLoading || !data ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-white border rounded-lg p-4 animate-pulse h-24" />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {/* Top stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              icon={Mail}
              label="Emails classified"
              value={data.emails.total}
              sub={
                <span className="inline-flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3 text-amber-500" />
                  {data.emails.upset} upset customer{data.emails.upset === 1 ? '' : 's'}
                </span>
              }
            />
            <StatCard
              icon={MessageCircle}
              label="Social comments"
              value={
                <span className="inline-flex items-center gap-2">
                  {data.social.comments}
                  <Delta now={data.social.comments} prev={data.social.prevComments} />
                </span>
              }
              sub={`${data.social.adComments} on ads`}
            />
            <StatCard
              icon={Star}
              label="Avg review rating"
              value={
                <span className="inline-flex items-center gap-2">
                  {data.reviews.avgRating ? data.reviews.avgRating.toFixed(1) : '-'}
                  <span className="text-sm text-gray-400">/ 5</span>
                </span>
              }
              sub={`${data.reviews.total} reviews, ${data.reviews.lowStar} low-star (prev avg ${
                data.reviews.prevAvgRating ? data.reviews.prevAvgRating.toFixed(1) : '-'
              })`}
            />
            <StatCard
              icon={Repeat}
              label="Replacement orders"
              value={
                <span className="inline-flex items-center gap-2">
                  {data.replacements.total}
                  <Delta now={data.replacements.total} prev={data.replacements.prevTotal} />
                </span>
              }
              sub={`vs ${data.replacements.prevTotal} in previous ${days} days`}
            />
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            {/* Most common email issues */}
            <div className="bg-white border rounded-lg p-5">
              <h2 className="font-semibold text-gray-900 mb-1">Most common email issues</h2>
              <p className="text-xs text-gray-500 mb-4">
                AI-classified intents, with change vs the previous {days} days
              </p>
              {sortedIntents.length === 0 ? (
                <p className="text-sm text-gray-500">No classified emails in this window yet.</p>
              ) : (
                <div className="space-y-3">
                  {sortedIntents.map((i) => {
                    const pct = totalIntents ? Math.round((i.count / totalIntents) * 100) : 0;
                    return (
                      <div key={i.intent}>
                        <div className="flex items-center justify-between text-sm mb-1">
                          <span className="text-gray-700">
                            {INTENT_LABELS[i.intent] || i.intent}
                          </span>
                          <span className="flex items-center gap-2">
                            <span className="text-gray-900 font-medium">
                              {i.count} ({pct}%)
                            </span>
                            <Delta now={i.count} prev={i.prevCount} />
                          </span>
                        </div>
                        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${pct}%`,
                              backgroundColor: INTENT_COLORS[i.intent] || '#9ca3af',
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Replacement reasons */}
            <div className="bg-white border rounded-lg p-5">
              <h2 className="font-semibold text-gray-900 mb-1">Replacement reasons</h2>
              <p className="text-xs text-gray-500 mb-4">
                From replacement-order tags (older replacements may show as
                &quot;unspecified&quot; - tagging started June 2026)
              </p>
              {reasonsTotal === 0 ? (
                <p className="text-sm text-gray-500">No replacement orders in this window.</p>
              ) : (
                <div className="space-y-3">
                  {(
                    [
                      ['Too small', reasons!.tooSmall, '#8b5cf6'],
                      ['Too large', reasons!.tooLarge, '#3b82f6'],
                      ['Color change', reasons!.colorChange, '#f59e0b'],
                      ['Unspecified', reasons!.other, '#9ca3af'],
                    ] as const
                  ).map(([label, count, color]) => {
                    const pct = Math.round((count / reasonsTotal) * 100);
                    return (
                      <div key={label}>
                        <div className="flex items-center justify-between text-sm mb-1">
                          <span className="text-gray-700">{label}</span>
                          <span className="text-gray-900 font-medium">
                            {count} ({pct}%)
                          </span>
                        </div>
                        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${pct}%`, backgroundColor: color }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Weekly issue trend */}
          <div className="bg-white border rounded-lg p-5">
            <h2 className="font-semibold text-gray-900 mb-1">Issue trend by week</h2>
            <p className="text-xs text-gray-500 mb-4">Classified emails per week, by issue type</p>
            {data.emails.weekly.length === 0 ? (
              <p className="text-sm text-gray-500">Not enough data yet.</p>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.emails.weekly}>
                    <XAxis dataKey="week" fontSize={12} />
                    <YAxis allowDecimals={false} fontSize={12} />
                    <Tooltip />
                    <Legend
                      formatter={(value: string) => INTENT_LABELS[value] || value}
                    />
                    {Object.keys(INTENT_LABELS).map((intent) => (
                      <Bar
                        key={intent}
                        dataKey={intent}
                        stackId="a"
                        fill={INTENT_COLORS[intent]}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Per-product replacement rates */}
          <div className="bg-white border rounded-lg p-5">
            <h2 className="font-semibold text-gray-900 mb-1">Replacement rate by product</h2>
            <p className="text-xs text-gray-500 mb-4">
              Replacement units vs units sold in the window (products with sales
              or replacements; sorted by rate)
            </p>
            {data.replacements.perProduct.length === 0 ? (
              <p className="text-sm text-gray-500">No product data in this window.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b">
                    <th className="py-2 pr-2">Product</th>
                    <th className="py-2 px-2 text-right">Units sold</th>
                    <th className="py-2 px-2 text-right">Replaced</th>
                    <th className="py-2 pl-2 text-right">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.replacements.perProduct.map((p) => (
                    <tr key={p.title} className="border-b last:border-0">
                      <td className="py-2 pr-2 text-gray-900">{p.title}</td>
                      <td className="py-2 px-2 text-right text-gray-700">{p.unitsSold}</td>
                      <td className="py-2 px-2 text-right text-gray-700">{p.replacements}</td>
                      <td
                        className={cn(
                          'py-2 pl-2 text-right font-medium',
                          p.rate >= 5
                            ? 'text-red-600'
                            : p.rate > 0
                              ? 'text-amber-600'
                              : 'text-gray-500'
                        )}
                      >
                        {p.rate.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <p className="text-xs text-gray-400">
            Data refreshes every 15 minutes. Generated{' '}
            {new Date(data.generatedAt).toLocaleTimeString()}.
          </p>
        </div>
      )}
    </div>
  );
}
