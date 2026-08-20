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
  ORDER_ISSUE: 'Order issue (wrong/damaged)',
  RETURN_REFUND: 'Return / refund',
  DISCOUNT: 'Discount',
  PRODUCT_QUESTION: 'Product question',
  POSITIVE_FEEDBACK: 'Positive feedback',
  UNSUBSCRIBE: 'Unsubscribe',
  WHOLESALE: 'Wholesale',
  SPAM: 'Spam / vendor',
  OTHER: 'Other',
};

const INTENT_COLORS: Record<string, string> = {
  SIZE_EXCHANGE: '#8b5cf6',
  SHIPPING_STATUS: '#3b82f6',
  ADDRESS_UPDATE: '#f59e0b',
  CANCELLATION: '#ef4444',
  ORDER_ISSUE: '#f43f5e',
  RETURN_REFUND: '#f97316',
  DISCOUNT: '#ec4899',
  PRODUCT_QUESTION: '#14b8a6',
  POSITIVE_FEEDBACK: '#10b981',
  UNSUBSCRIBE: '#9f1239',
  WHOLESALE: '#6366f1',
  SPAM: '#6b7280',
  OTHER: '#9ca3af',
};

interface Insights {
  windowDays: number;
  generatedAt: string;
  emails: {
    intents: { intent: string; count: number; prevCount: number }[];
    upset: number;
    weekly: ({ week: string } & Record<string, number | string>)[];
    daily: { day: string; count: number }[];
    received: number;
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
  team?: {
    totalReplies: number;
    medianFirstResponseMins: number;
    avgFirstResponseMins: number;
    agents: { userId: string; name: string; replies: number; medianResponseMins: number }[];
  };
  replacements: {
    total: number;
    unattributed?: number;
    cohortStart?: string;
    cohortEnd?: string;
    baselineRate?: number;
    highRate?: number;
    prevTotal: number;
    reasons: {
      tooSmall: number;
      tooLarge: number;
      colorChange: number;
      defect: number;
      wrongItem: number;
      other: number;
    };
    perProduct: {
      title: string;
      unitsSold: number;
      replacements: number;
      rate: number;
      reasons: Record<string, number>;
    }[];
    topByVolume?: {
      title: string;
      unitsSold: number;
      replacements: number;
      rate: number;
      reasons: Record<string, number>;
    }[];
    byType: {
      type: string;
      unitsSold: number;
      replacements: number;
      rate: number;
      reasons: Record<string, number>;
    }[];
    byGender?: Record<
      'female' | 'male' | 'unknown',
      { total: number; tooSmall: number; tooLarge: number }
    >;
  };
}

const REASON_LABELS: Record<string, string> = {
  tooSmall: 'Too small',
  tooLarge: 'Too large',
  neckTooTight: 'Neck too tight',
  defect: 'Defect/print',
  wrongItem: 'Wrong item',
  colorChange: 'Color',
  other: 'Unspecified',
};

/** Minutes -> compact duration ("3m", "2h 5m", "1d 3h"). */
function fmtMins(mins: number): string {
  if (!mins || mins < 1) return '< 1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const m = mins % 60;
    return m ? `${hours}h ${m}m` : `${hours}h`;
  }
  const dys = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${dys}d ${h}h` : `${dys}d`;
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

/** "Jun 21 - Jul 21" from two YYYY-MM-DD keys, for the cohort label. */
function cohortLabel(start?: string, end?: string): string | null {
  if (!start || !end) return null;
  const fmt = (key: string) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  };
  return `${fmt(start)} - ${fmt(end)}`;
}

/** "Aug 11 - Aug 17" from a Monday key (YYYY-MM-DD). Parsed as UTC so the
 *  label never slides back a day in a western timezone. */
function weekLabel(mondayKey: string): string {
  const [y, m, d] = mondayKey.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(Date.UTC(y, m - 1, d + 6));
  const fmt = (dt: Date) =>
    dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${fmt(start)} - ${fmt(end)}`;
}

/** Issue counts for one week row, biggest first, zeros dropped. */
function weekIssues(row: Record<string, number | string>): { intent: string; count: number }[] {
  return Object.keys(INTENT_LABELS)
    .map((intent) => ({ intent, count: Number(row[intent]) || 0 }))
    .filter((i) => i.count > 0)
    .sort((a, b) => b.count - a.count);
}

/** Change vs the same issue last week, in words rather than a shifting bar. */
function IssueDelta({ diff, isNew }: { diff: number; isNew: boolean }) {
  if (isNew) return <span className="text-xs text-gray-500">new</span>;
  if (diff === 0) return <span className="text-xs text-gray-400">same</span>;
  return (
    <span className="inline-flex items-center gap-0.5 text-xs text-gray-500">
      {diff > 0 ? (
        <TrendingUp className="w-3 h-3" />
      ) : (
        <TrendingDown className="w-3 h-3" />
      )}
      {diff > 0 ? '+' : ''}
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
    ? reasons.tooSmall +
      reasons.tooLarge +
      reasons.colorChange +
      reasons.defect +
      reasons.wrongItem +
      reasons.other
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
              label="Emails received"
              value={data.emails.received}
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

          {data.team && data.team.totalReplies > 0 && (
            <div className="bg-white border rounded-lg p-5">
              <h2 className="font-semibold text-gray-900 mb-1">Team</h2>
              <p className="text-xs text-gray-500 mb-4">
                Replies sent and how fast the first reply went out, over the last {days} days
              </p>
              <div className="grid sm:grid-cols-3 gap-4 mb-4">
                <div>
                  <p className="text-xs text-gray-500">Replies sent</p>
                  <p className="text-2xl font-semibold text-gray-900">{data.team.totalReplies}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Median first response</p>
                  <p className="text-2xl font-semibold text-gray-900">{fmtMins(data.team.medianFirstResponseMins)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Avg first response</p>
                  <p className="text-2xl font-semibold text-gray-900">{fmtMins(data.team.avgFirstResponseMins)}</p>
                </div>
              </div>
              {data.team.agents.length > 0 && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b">
                      <th className="py-1.5 font-medium">Agent</th>
                      <th className="py-1.5 font-medium text-right">Replies</th>
                      <th className="py-1.5 font-medium text-right">Median response</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.team.agents.map((a) => (
                      <tr key={a.userId} className="border-b last:border-0">
                        <td className="py-1.5 text-gray-900">{a.name}</td>
                        <td className="py-1.5 text-right text-gray-900">{a.replies}</td>
                        <td className="py-1.5 text-right text-gray-600">{fmtMins(a.medianResponseMins)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

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
                From replacement-order tags and notes
              </p>
              {reasonsTotal === 0 ? (
                <p className="text-sm text-gray-500">No replacement orders in this window.</p>
              ) : (
                <div className="space-y-3">
                  {(
                    [
                      ['Too small', reasons!.tooSmall, '#8b5cf6'],
                      ['Too large', reasons!.tooLarge, '#3b82f6'],
                      ['Defect / print issue', reasons!.defect, '#ef4444'],
                      ['Wrong item ordered', reasons!.wrongItem, '#f97316'],
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

            {/* Exchanges by gender */}
            {data.replacements.byGender && (
              <div className="bg-white border rounded-lg p-5">
                <h2 className="font-semibold text-gray-900 mb-1">
                  Who requests exchanges
                </h2>
                <p className="text-xs text-gray-500 mb-4">
                  Inferred from the billing first name on the original order
                </p>
                {(() => {
                  const g = data.replacements.byGender!;
                  const known = g.female.total + g.male.total;
                  if (known === 0) {
                    return (
                      <p className="text-sm text-gray-500">
                        No replacement orders with a recognizable first name in
                        this window.
                      </p>
                    );
                  }
                  return (
                    <div className="space-y-4">
                      {(
                        [
                          ['Women', g.female, '#ec4899'],
                          ['Men', g.male, '#3b82f6'],
                        ] as const
                      ).map(([label, stats, color]) => {
                        const pct = Math.round((stats.total / known) * 100);
                        return (
                          <div key={label}>
                            <div className="flex items-center justify-between text-sm mb-1">
                              <span className="text-gray-700">{label}</span>
                              <span className="text-gray-900 font-medium">
                                {stats.total} ({pct}%)
                              </span>
                            </div>
                            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                              <div
                                className="h-full rounded-full"
                                style={{ width: `${pct}%`, backgroundColor: color }}
                              />
                            </div>
                            {(stats.tooSmall > 0 || stats.tooLarge > 0) && (
                              <p className="text-xs text-gray-500 mt-1">
                                {stats.tooSmall} too small · {stats.tooLarge} too
                                large
                              </p>
                            )}
                          </div>
                        );
                      })}
                      {g.unknown.total > 0 && (
                        <p className="text-xs text-gray-400">
                          {g.unknown.total} more couldn&apos;t be matched to a
                          gender (unisex or uncommon names) and are left out of
                          the percentages.
                        </p>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Emails per day */}
          <div className="bg-white border rounded-lg p-5">
            <h2 className="font-semibold text-gray-900 mb-1">Emails received per day</h2>
            <p className="text-xs text-gray-500 mb-4">
              Inbound customer emails landing in the inbox
            </p>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.emails.daily}>
                  <XAxis dataKey="day" fontSize={11} interval="preserveStartEnd" />
                  <YAxis allowDecimals={false} fontSize={12} />
                  <Tooltip />
                  <Bar dataKey="count" name="Emails" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Weekly issue trend */}
          <div className="bg-white border rounded-lg p-5">
            <h2 className="font-semibold text-gray-900 mb-1">Issue trend by week</h2>
            <p className="text-xs text-gray-500 mb-4">
              What customers wrote in about each week, biggest issue first, with
              the change against the week before. Newest week on top.
            </p>
            {data.emails.weekly.length === 0 ? (
              <p className="text-sm text-gray-500">Not enough data yet.</p>
            ) : (
              <div className="space-y-5">
                {[...data.emails.weekly]
                  .map((row, i, all) => ({ row, prev: all[i - 1] }))
                  .reverse()
                  .map(({ row, prev }, idx) => {
                    const issues = weekIssues(row);
                    const total = issues.reduce((sum, i) => sum + i.count, 0);
                    const prevIssues = prev ? weekIssues(prev) : [];
                    const prevTotal = prevIssues.reduce((sum, i) => sum + i.count, 0);
                    const prevBy = new Map(prevIssues.map((i) => [i.intent, i.count]));
                    const top = issues.slice(0, 6);
                    const rest = issues.slice(6);
                    return (
                      <div key={row.week as string}>
                        <div className="flex items-baseline justify-between border-b pb-1.5 mb-2">
                          <h3 className="text-sm font-semibold text-gray-900">
                            {weekLabel(row.week as string)}
                            {idx === 0 && (
                              <span className="ml-2 text-xs font-normal text-gray-400">
                                this week so far
                              </span>
                            )}
                          </h3>
                          <div className="flex items-center gap-2 text-xs text-gray-500">
                            {total} email{total === 1 ? '' : 's'}
                            {prev && <Delta now={total} prev={prevTotal} />}
                          </div>
                        </div>
                        <ul className="space-y-1.5">
                          {top.map((issue) => {
                            const had = prevBy.has(issue.intent);
                            const share = total > 0 ? (issue.count / total) * 100 : 0;
                            return (
                              <li
                                key={issue.intent}
                                className="flex items-center gap-3 text-sm"
                              >
                                <span
                                  className="w-2 h-2 rounded-full shrink-0"
                                  style={{ backgroundColor: INTENT_COLORS[issue.intent] }}
                                />
                                <span className="text-gray-900 w-56 shrink-0 truncate">
                                  {INTENT_LABELS[issue.intent] || issue.intent}
                                </span>
                                <span className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                  <span
                                    className="block h-full rounded-full"
                                    style={{
                                      width: `${share}%`,
                                      backgroundColor: INTENT_COLORS[issue.intent],
                                    }}
                                  />
                                </span>
                                <span className="text-gray-700 tabular-nums w-8 text-right shrink-0">
                                  {issue.count}
                                </span>
                                <span className="text-gray-400 tabular-nums w-10 text-right shrink-0 text-xs">
                                  {share.toFixed(0)}%
                                </span>
                                <span className="w-14 text-right shrink-0">
                                  {prev && (
                                    <IssueDelta
                                      diff={issue.count - (prevBy.get(issue.intent) || 0)}
                                      isNew={!had}
                                    />
                                  )}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                        {rest.length > 0 && (
                          <p className="text-xs text-gray-400 mt-1.5 pl-5">
                            {rest.length} more:{' '}
                            {rest
                              .map(
                                (i) =>
                                  `${INTENT_LABELS[i.intent] || i.intent} ${i.count}`
                              )
                              .join(' · ')}
                          </p>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
          </div>

          {/* Replacement by garment type */}
          {data.replacements.byType.length > 0 && (
            <div className="bg-white border rounded-lg p-5">
              <h2 className="font-semibold text-gray-900 mb-1">
                Replacements by garment type
              </h2>
              <p className="text-xs text-gray-500 mb-4">
                Classic tee (Gildan 64000) vs Premium (Comfort Colors) vs
                v-necks, long sleeves, hoodies, sweatshirts, kids - with the
                reason mix per type. Same sales cohort as the table below
                {cohortLabel(
                  data.replacements.cohortStart,
                  data.replacements.cohortEnd
                )
                  ? ` (${cohortLabel(data.replacements.cohortStart, data.replacements.cohortEnd)})`
                  : ''}
                .
              </p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b">
                    <th className="py-2 pr-2">Type</th>
                    <th className="py-2 px-2 text-right">Units sold</th>
                    <th className="py-2 px-2 text-right">Replaced</th>
                    <th className="py-2 px-2 text-right">Rate</th>
                    <th className="py-2 pl-2">Reasons</th>
                  </tr>
                </thead>
                <tbody>
                  {data.replacements.byType.map((t) => (
                    <tr key={t.type} className="border-b last:border-0">
                      <td className="py-2 pr-2 text-gray-900 font-medium">{t.type}</td>
                      <td className="py-2 px-2 text-right text-gray-700">{t.unitsSold}</td>
                      <td className="py-2 px-2 text-right text-gray-700">{t.replacements}</td>
                      <td
                        className={cn(
                          'py-2 px-2 text-right font-medium',
                          t.rate >= 5
                            ? 'text-red-600'
                            : t.rate > 0
                              ? 'text-amber-600'
                              : 'text-gray-500'
                        )}
                      >
                        {t.rate.toFixed(1)}%
                      </td>
                      <td className="py-2 pl-2 text-xs text-gray-600">
                        {Object.entries(t.reasons)
                          .sort(([, a], [, b]) => b - a)
                          .map(([k, v]) => `${REASON_LABELS[k] || k} ${v}`)
                          .join(' · ') || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Per-product replacement rates */}
          <div className="bg-white border rounded-lg p-5">
            <h2 className="font-semibold text-gray-900 mb-1">Replacement rate by product</h2>
            <p className="text-xs text-gray-500 mb-4">
              Of the shirts sold{' '}
              <span className="font-medium text-gray-600">
                {cohortLabel(
                  data.replacements.cohortStart,
                  data.replacements.cohortEnd
                ) || 'in the cohort month'}
              </span>
              , the share that has come back since - counted against the product
              the customer had a problem with, not the one we shipped as the
              fix. Those months are used because 95% of replacements happen
              within 30 days of the sale, so they have had time to be honest;
              this week&apos;s sales have not. Listed only if more than 10 units
              sold, at least 3 replaced, and a rate at or above{' '}
              {typeof data.replacements.highRate === 'number'
                ? `${data.replacements.highRate.toFixed(1)}%`
                : 'the bar'}
              {typeof data.replacements.baselineRate === 'number' && (
                <> - twice the {data.replacements.baselineRate.toFixed(1)}% the
                  store averages across every product.</>
              )}
              {typeof data.replacements.unattributed === 'number' &&
                data.replacements.unattributed > 0 && (
                  <>
                    {' '}
                    {data.replacements.unattributed} recent replacement
                    {data.replacements.unattributed === 1 ? '' : 's'} could not
                    be traced to an original order and{' '}
                    {data.replacements.unattributed === 1 ? 'is' : 'are'} left
                    out.
                  </>
                )}
            </p>
            {data.replacements.perProduct.length === 0 ? (
              <p className="text-sm text-gray-500">
                No product is coming back meaningfully more often than the
                store average. Nothing to act on.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b">
                    <th className="py-2 pr-2">Product</th>
                    <th className="py-2 px-2 text-right">Units sold</th>
                    <th className="py-2 px-2 text-right">Replaced</th>
                    <th className="py-2 px-2 text-right">Rate</th>
                    <th className="py-2 pl-2">Reasons</th>
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
                          'py-2 px-2 text-right font-medium',
                          p.rate >= (data.replacements.highRate ?? 5) * 1.5
                            ? 'text-red-600'
                            : p.rate > 0
                              ? 'text-amber-600'
                              : 'text-gray-500'
                        )}
                      >
                        {p.rate.toFixed(1)}%
                      </td>
                      <td className="py-2 pl-2 text-xs text-gray-600">
                        {Object.entries(p.reasons)
                          .sort(([, a], [, b]) => b - a)
                          .map(([k, v]) => `${REASON_LABELS[k] || k} ${v}`)
                          .join(' · ') || 'Not tagged'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Where the replacement volume actually sits */}
          {data.replacements.topByVolume &&
            data.replacements.topByVolume.length > 0 && (
              <div className="bg-white border rounded-lg p-5">
                <h2 className="font-semibold text-gray-900 mb-1">
                  Most replacements by volume
                </h2>
                <p className="text-xs text-gray-500 mb-4">
                  Where the replacement cost actually sits, same sales cohort. A
                  bestseller can be your single biggest source of replacements
                  while sitting at or below the{' '}
                  {typeof data.replacements.baselineRate === 'number'
                    ? `${data.replacements.baselineRate.toFixed(1)}%`
                    : 'store'}{' '}
                  store average - so it never appears on the table above, which
                  only flags products that are unusually bad.
                </p>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b">
                      <th className="py-2 pr-2">Product</th>
                      <th className="py-2 px-2 text-right">Units sold</th>
                      <th className="py-2 px-2 text-right">Replaced</th>
                      <th className="py-2 px-2 text-right">Rate</th>
                      <th className="py-2 pl-2">Reasons</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.replacements.topByVolume.map((p) => (
                      <tr key={p.title} className="border-b last:border-0">
                        <td className="py-2 pr-2 text-gray-900">{p.title}</td>
                        <td className="py-2 px-2 text-right text-gray-700">
                          {p.unitsSold}
                        </td>
                        <td className="py-2 px-2 text-right font-medium text-gray-900">
                          {p.replacements}
                        </td>
                        <td
                          className={cn(
                            'py-2 px-2 text-right',
                            p.rate >= (data.replacements.highRate ?? 5)
                              ? 'text-red-600 font-medium'
                              : 'text-gray-500'
                          )}
                        >
                          {p.rate.toFixed(1)}%
                        </td>
                        <td className="py-2 pl-2 text-xs text-gray-600">
                          {Object.entries(p.reasons)
                            .sort(([, a], [, b]) => b - a)
                            .map(([k, v]) => `${REASON_LABELS[k] || k} ${v}`)
                            .join(' · ') || 'Not tagged'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

          <p className="text-xs text-gray-400">
            Data refreshes every 15 minutes. Generated{' '}
            {new Date(data.generatedAt).toLocaleTimeString()}.
          </p>
        </div>
      )}
    </div>
  );
}
