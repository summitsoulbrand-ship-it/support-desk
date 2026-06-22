'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Clock, RefreshCcw, ExternalLink, Flag, Truck, Check, DollarSign, Mail } from 'lucide-react';

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
  customerRefunded: boolean | null;
  refundedByPrintify: boolean | null;
  note: string | null;
  customerEmail: string | null;
  customerName: string | null;
  delayEmailedAt: string | null;
  resolved: boolean;
}

interface LateOrdersResponse {
  thresholdDays: number;
  count: number;
  orders: LateOrder[];
  cached?: boolean;
  cachedAt?: string;
}

// Pre-written delay-update email, ready for the operator to review and edit.
function delayDraft(o: LateOrder): string {
  const first = o.customerName?.trim().split(/\s+/)[0] || 'there';
  return [
    `Hi ${first},`,
    '',
    `I wanted to reach out personally about your order ${o.orderName}. It is taking a little longer than expected to reach you, and I am so sorry for the wait.`,
    '',
    'We are keeping a close eye on it and will make sure it gets to you. If there is anything I can do in the meantime, just reply to this email.',
    '',
    'Thanks so much for your patience!',
    '',
    'Best,',
    'Pati | Summit Soul',
  ].join('\n');
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

type ResolutionPatch = {
  customerRefunded?: boolean | null;
  refundedByPrintify?: boolean | null;
  note?: string | null;
};

// Mirror of the server's derived-resolution rule so optimistic updates move an
// order between tabs immediately: customer made whole AND Printify decided.
function computeResolved(o: LateOrder): boolean {
  const customerWhole = !!o.replacement || !!o.refund || o.customerRefunded === true;
  const printifyDecided = o.refundedByPrintify === true || o.refundedByPrintify === false;
  return customerWhole && printifyDecided;
}

// Three-state yes/no control. Clicking the active value again clears it (null).
function YesNo({
  value,
  onChange,
}: {
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded border border-gray-300 text-xs">
      <button
        onClick={() => onChange(value === true ? null : true)}
        className={`px-2 py-0.5 ${
          value === true ? 'bg-emerald-600 text-white' : 'text-gray-600 hover:bg-gray-100'
        }`}
      >
        Yes
      </button>
      <button
        onClick={() => onChange(value === false ? null : false)}
        className={`border-l border-gray-300 px-2 py-0.5 ${
          value === false ? 'bg-rose-600 text-white' : 'text-gray-600 hover:bg-gray-100'
        }`}
      >
        No
      </button>
    </div>
  );
}

export default function LateOrdersPage() {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<'open' | 'solved'>('open');
  const [draftingId, setDraftingId] = useState<string | null>(null);
  const [draftBody, setDraftBody] = useState('');
  const [sending, setSending] = useState(false);

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

  // Patch one or more resolution fields; recompute resolved locally so the row
  // moves tabs instantly, then persist.
  const patch = async (o: LateOrder, p: ResolutionPatch) => {
    queryClient.setQueryData<LateOrdersResponse>(['late-orders'], (prev) =>
      prev
        ? {
            ...prev,
            orders: prev.orders.map((x) => {
              if (x.printifyOrderId !== o.printifyOrderId) return x;
              const merged = { ...x, ...p };
              return { ...merged, resolved: computeResolved(merged) };
            }),
          }
        : prev
    );
    await fetch('/api/late-orders/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printifyOrderId: o.printifyOrderId, ...p }),
    });
  };

  // Send the (reviewed) delay-update email through the support desk, then mark
  // the order emailed so the status sticks.
  const sendDraft = async (o: LateOrder) => {
    if (!o.customerEmail) {
      window.alert('No customer email on file for this order.');
      return;
    }
    setSending(true);
    try {
      const subject = `Your Summit Soul order ${o.orderName} - a quick update`;
      const bodyHtml = draftBody
        .split('\n\n')
        .map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
        .join('');
      const send = await fetch('/api/threads/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: o.customerEmail,
          toName: o.customerName || undefined,
          subject,
          bodyHtml,
          bodyText: draftBody,
        }),
      });
      if (!send.ok) {
        const j = await send.json().catch(() => ({}));
        throw new Error(j.error || 'Failed to send the email.');
      }
      const stamp = new Date().toISOString();
      queryClient.setQueryData<LateOrdersResponse>(['late-orders'], (prev) =>
        prev
          ? {
              ...prev,
              orders: prev.orders.map((x) =>
                x.printifyOrderId === o.printifyOrderId ? { ...x, delayEmailedAt: stamp } : x
              ),
            }
          : prev
      );
      await fetch('/api/late-orders/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ printifyOrderId: o.printifyOrderId, delayEmailed: true }),
      });
      setDraftingId(null);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setSending(false);
    }
  };

  const solvedOrders = orders.filter((o) => o.resolved);
  const openOrders = orders.filter((o) => !o.resolved);
  const visible = tab === 'solved' ? solvedOrders : openOrders;

  return (
    <div className="p-6 max-w-6xl mx-auto">
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
        Resolved when the customer is made whole (refund or replacement) AND a Printify-refund
        decision is recorded. Notes never resolve an order.{' '}
        {data?.cached ? 'Cached - hit Refresh to re-pull.' : ''}
      </p>

      {!isLoading && orders.length > 0 && (
        <div className="mb-3 flex gap-1 border-b border-gray-200">
          {([
            ['open', 'Needs action', openOrders.length],
            ['solved', 'Resolved', solvedOrders.length],
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
            ? 'Nothing unresolved - every late order is made whole and has a Printify decision.'
            : 'No resolved orders yet.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Order</th>
                <th className="px-3 py-2 text-left font-medium">Days</th>
                <th className="px-3 py-2 text-left font-medium">Delivery status</th>
                <th className="px-3 py-2 text-left font-medium">Customer refunded</th>
                <th className="px-3 py-2 text-left font-medium">Refunded by Printify</th>
                <th className="px-3 py-2 text-left font-medium">Notes</th>
                <th className="px-3 py-2 text-left font-medium">Delay email</th>
                <th className="px-3 py-2 text-left font-medium">Links</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visible.map((o) => (
                <Fragment key={o.printifyOrderId}>
                <tr className="hover:bg-gray-50 align-top">
                  <td className="px-3 py-2 font-medium">
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
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                        o.daysSinceOrdered >= 21
                          ? 'bg-rose-100 text-rose-800'
                          : o.daysSinceOrdered >= 17
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-yellow-50 text-yellow-700'
                      }`}
                    >
                      {o.daysSinceOrdered}d
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                      {o.deliveryStatus || 'unknown'}
                    </span>
                  </td>
                  {/* Customer made whole: auto badges (replacement/refund) or a manual toggle */}
                  <td className="px-3 py-2">
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
                      {!o.replacement && !o.refund && (
                        <YesNo
                          value={o.customerRefunded}
                          onChange={(v) => patch(o, { customerRefunded: v })}
                        />
                      )}
                    </div>
                  </td>
                  {/* Refunded by Printify: yes/no */}
                  <td className="px-3 py-2">
                    <YesNo
                      value={o.refundedByPrintify}
                      onChange={(v) => patch(o, { refundedByPrintify: v })}
                    />
                  </td>
                  {/* Notes: informational, never resolves */}
                  <td className="px-3 py-2">
                    <input
                      key={`${o.printifyOrderId}:${o.note ?? ''}`}
                      defaultValue={o.note ?? ''}
                      placeholder="Add note..."
                      onBlur={(e) => {
                        const next = e.target.value.trim() || null;
                        if (next !== (o.note ?? null)) patch(o, { note: next });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                      className="w-44 rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 focus:border-gray-400 focus:outline-none"
                    />
                  </td>
                  {/* Delay email: draft -> review -> send via the tool */}
                  <td className="px-3 py-2">
                    {o.delayEmailedAt ? (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                        <Check className="w-3 h-3" /> Emailed {fmtDate(o.delayEmailedAt)}
                        <button
                          onClick={() => {
                            setDraftingId(o.printifyOrderId);
                            setDraftBody(delayDraft(o));
                          }}
                          className="ml-1 text-gray-500 hover:text-gray-700 underline"
                        >
                          again
                        </button>
                      </span>
                    ) : o.customerEmail ? (
                      <button
                        onClick={() => {
                          setDraftingId(o.printifyOrderId);
                          setDraftBody(delayDraft(o));
                        }}
                        className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 hover:text-amber-800"
                      >
                        <Mail className="w-3.5 h-3.5" /> Draft email
                      </button>
                    ) : (
                      <span className="text-xs text-gray-400">No email</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-3">
                      {o.trackingUrl && (
                        <a
                          href={o.trackingUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800"
                          title="Track"
                        >
                          <Truck className="w-4 h-4" />
                        </a>
                      )}
                      <a
                        href={o.printifyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-rose-600 hover:text-rose-800"
                        title="Open in Printify"
                      >
                        <Flag className="w-4 h-4" />
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </td>
                </tr>
                {draftingId === o.printifyOrderId && (
                  <tr className="bg-amber-50/40">
                    <td colSpan={8} className="px-3 py-3">
                      <div className="mb-1 text-xs text-gray-500">
                        To: {o.customerName ? `${o.customerName} ` : ''}&lt;{o.customerEmail}&gt;
                        {'  ·  '}Subject: Your Summit Soul order {o.orderName} - a quick update
                      </div>
                      <textarea
                        value={draftBody}
                        onChange={(e) => setDraftBody(e.target.value)}
                        rows={9}
                        className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-gray-400 focus:outline-none"
                      />
                      <div className="mt-2 flex items-center gap-3">
                        <button
                          onClick={() => sendDraft(o)}
                          disabled={sending}
                          className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
                        >
                          <Mail className="w-3.5 h-3.5" /> {sending ? 'Sending...' : 'Send email'}
                        </button>
                        <button
                          onClick={() => setDraftingId(null)}
                          className="text-xs text-gray-500 hover:text-gray-700"
                        >
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
