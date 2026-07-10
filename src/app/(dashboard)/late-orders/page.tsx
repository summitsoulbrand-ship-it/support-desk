'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import Link from 'next/link';
import { Clock, RefreshCcw, ExternalLink, Check, Copy, DollarSign, Mail } from 'lucide-react';
import { DelayEmailModal, DelayEmailTemplate } from '@/components/delay-email-modal';

interface LateOrder {
  printifyOrderId: string;
  orderName: string;
  printifyOrderNumber: string | null;
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
  // Shopify was checked and shows $0 refunded - display an auto "No" default.
  shopifyNoRefund?: boolean;
  customerRefunded: boolean | null;
  refundedByPrintify: boolean | null;
  printifyRecovery: {
    type: string;
    amountUsd: number | null;
    date: string;
    // Printify's own sentence from their email - incl. the explanation when
    // they declined a refund.
    note: string | null;
    ticketUrl: string | null;
  } | null;
  awaitingPrintify: { intent: string | null; since: string } | null;
  note: string | null;
  handledAt: string | null;
  customerEmail: string | null;
  customerName: string | null;
  delayEmailedAt: string | null;
  escalationOpen: boolean;
  threadId: string | null;
  resolved: boolean;
}

interface LateOrdersResponse {
  thresholdDays: number;
  count: number;
  orders: LateOrder[];
  cached?: boolean;
  cachedAt?: string;
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
// order between tabs immediately: (customer made whole AND Printify decided),
// or the operator explicitly marked it done.
function computeResolved(o: LateOrder): boolean {
  const customerWhole = !!o.replacement || !!o.refund || o.customerRefunded === true;
  const printifyDecided = o.refundedByPrintify === true || o.refundedByPrintify === false;
  return (customerWhole && printifyDecided) || o.handledAt != null;
}

// Both refund questions answered (yes OR no, manual or auto) - the prerequisite
// for the manual Done button.
function bothQuestionsAnswered(o: LateOrder): boolean {
  const customerAnswered =
    !!o.replacement || !!o.refund || o.customerRefunded !== null || !!o.shopifyNoRefund;
  const printifyAnswered = o.refundedByPrintify !== null;
  return customerAnswered && printifyAnswered;
}

// ---------------------------------------------------------------------------
// Workflow stage - where the row sits in the operator's real flow:
//   1 contact-printify: nothing happened yet - message Printify support.
//   2 awaiting-printify: asked Printify (refund/reprint), no confirmation yet.
//   3 customer-next: Printify decided (refunded us, or declined) but the
//     customer is not made whole yet - ask them: refund or free replacement?
//   log-printify: customer IS whole (replacement/refund) but no Printify
//     decision recorded yet - tick Refunded by Printify yes/no and the row
//     resolves off the list (stage 4 rows are hidden by the resolved rule).
// Check order matters: a made-whole customer only needs the Printify outcome
// logged, and a recorded Printify decision trumps "awaiting".
// ---------------------------------------------------------------------------

// Three-state yes/no control. Clicking the active value again clears it (null).
// Deliberately small and muted - the stage pill is the primary signal.
function YesNo({
  value,
  onChange,
}: {
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded border border-gray-200 text-[11px]">
      <button
        onClick={() => onChange(value === true ? null : true)}
        className={`px-1.5 py-0.5 ${
          value === true
            ? 'bg-emerald-100 font-semibold text-emerald-800'
            : 'text-gray-500 hover:bg-gray-50'
        }`}
      >
        Yes
      </button>
      <button
        onClick={() => onChange(value === false ? null : false)}
        className={`border-l border-gray-200 px-1.5 py-0.5 ${
          value === false
            ? 'bg-rose-100 font-semibold text-rose-800'
            : 'text-gray-500 hover:bg-gray-50'
        }`}
      >
        No
      </button>
    </div>
  );
}

// Labeled link styled as a small button (min 28px tall) - big enough to hit.
const linkBtnCls =
  'inline-flex h-7 items-center gap-1 rounded-md border border-gray-200 bg-white px-2.5 text-xs font-medium text-gray-700 hover:bg-gray-50 hover:text-gray-900';

export default function LateOrdersPage() {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  // Order whose email draft is open for review before sending, plus which
  // template it opened with (delay update vs refund-or-replacement ask).
  const [emailing, setEmailing] = useState<{
    order: LateOrder;
    template: DelayEmailTemplate;
  } | null>(null);
  // Which order's Printify message was just copied (for the "Copied" flash).
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Rows ticked for the bulk "copy Printify #s" action, keyed by Printify id.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // How many numbers the bulk copy just put on the clipboard (for the flash).
  const [bulkCopied, setBulkCopied] = useState<number | null>(null);
  // "Late after" filter: 13 days by default; 0 = every undelivered order in the
  // 90-day (3-month) window.
  const [lateAfter, setLateAfter] = useState(13);

  const { data, isLoading } = useQuery<LateOrdersResponse>({
    queryKey: ['late-orders', lateAfter],
    queryFn: async () => {
      const res = await fetch(`/api/late-orders?days=${lateAfter}`);
      if (!res.ok) throw new Error('Failed to load late orders');
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  // Refresh forces a fresh live pull from Printify (bypasses the 30-min cache).
  const refreshFresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/late-orders?fresh=1&days=${lateAfter}`);
      if (res.ok) queryClient.setQueryData(['late-orders', lateAfter], await res.json());
    } finally {
      setRefreshing(false);
    }
  };

  const orders = data?.orders || [];
  const threshold = data?.thresholdDays || 13;

  // Patch one or more resolution fields; recompute resolved locally so the row
  // moves tabs instantly, then persist.
  const patch = async (o: LateOrder, p: ResolutionPatch) => {
    queryClient.setQueryData<LateOrdersResponse>(['late-orders', lateAfter], (prev) =>
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

  // After the DelayEmailModal sends the (reviewed) email through the support
  // desk, mark the order emailed so the status sticks.
  const recordDelayEmail = async (o: LateOrder) => {
    const stamp = new Date().toISOString();
    queryClient.setQueryData<LateOrdersResponse>(['late-orders', lateAfter], (prev) =>
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
  };

  // Quick-copy the Printify order number (what Printify support asks for).
  const copyPrintifyNumber = (o: LateOrder) => {
    navigator.clipboard?.writeText(o.printifyOrderNumber || o.printifyOrderId);
    setCopiedId(o.printifyOrderId);
    setTimeout(() => setCopiedId((c) => (c === o.printifyOrderId ? null : c)), 1500);
  };

  // Manual Done: gated on both refund questions being answered (the button is
  // disabled otherwise); optimistically drops the row off the list.
  const markDone = async (o: LateOrder) => {
    const stamp = new Date().toISOString();
    queryClient.setQueryData<LateOrdersResponse>(['late-orders', lateAfter], (prev) =>
      prev
        ? {
            ...prev,
            orders: prev.orders.map((x) =>
              x.printifyOrderId === o.printifyOrderId
                ? { ...x, handledAt: stamp, resolved: true }
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
        handled: true,
        // Customer side may be answered by an auto signal (Shopify refund,
        // replacement, $0-refund default) instead of the manual toggle.
        customerAutoAnswered: !!o.replacement || !!o.refund || !!o.shopifyNoRefund,
      }),
    });
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Bulk copy: every ticked row's Printify number, comma-separated, ready to
  // paste into one Printify support message.
  const copySelectedNumbers = (rows: LateOrder[]) => {
    const picked = rows.filter((o) => selected.has(o.printifyOrderId));
    if (picked.length === 0) return;
    const text = picked
      .map((o) => o.printifyOrderNumber || o.printifyOrderId)
      .join(', ');
    navigator.clipboard?.writeText(text);
    setBulkCopied(picked.length);
    setTimeout(() => setBulkCopied(null), 2000);
  };

  // Hide resolved orders - once the customer is made whole (replacement or
  // refund) AND the Printify decision is recorded, or the row was manually
  // marked Done, the order drops off the list.
  const resolvedCount = orders.filter((o) => o.resolved).length;
  const visible = orders.filter((o) => !o.resolved);
  const allVisibleSelected =
    visible.length > 0 && visible.every((o) => selected.has(o.printifyOrderId));

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          <Clock className="w-5 h-5 text-rose-600" />
          Late deliveries
        </h1>
        <div className="flex items-center gap-3">
          {selected.size > 0 && (
            <button
              onClick={() => copySelectedNumbers(visible)}
              className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-sm font-medium text-indigo-700 hover:bg-indigo-100"
              title="Copy the ticked orders' Printify numbers, comma-separated - paste them into one Printify support message"
            >
              <Copy className="w-3.5 h-3.5" />
              {bulkCopied != null
                ? `Copied ${bulkCopied} number${bulkCopied === 1 ? '' : 's'}`
                : `Copy ${selected.size} Printify #${selected.size === 1 ? '' : 's'}`}
            </button>
          )}
          <label className="text-sm text-gray-600 flex items-center gap-1">
            Late after:
            <select
              value={lateAfter}
              onChange={(e) => setLateAfter(parseInt(e.target.value, 10))}
              className="border border-gray-300 rounded px-1.5 py-1 text-sm text-gray-900"
            >
              <option value={13}>13 days (default)</option>
              <option value={7}>7 days</option>
              <option value={3}>3 days</option>
              <option value={0}>All undelivered</option>
            </select>
          </label>
          <button
            onClick={refreshFresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 disabled:opacity-50"
          >
            <RefreshCcw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Pulling from Printify...' : 'Refresh'}
          </button>
        </div>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        {threshold === 0
          ? 'Every order not yet delivered'
          : `Not delivered within ${threshold} days of ordering`}
        , from the last 3 months (from Printify).{' '}
        Resolved orders are hidden: once the customer is made whole (refund or replacement) AND a
        Printify-refund decision is recorded - or you hit Done - the order drops off.{' '}
        {resolvedCount > 0 ? `(${resolvedCount} resolved, hidden.) ` : ''}
        {data?.cached ? 'Cached - hit Refresh to re-pull.' : ''}
      </p>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center text-sm text-gray-500">
          {resolvedCount > 0
            ? `All caught up - ${resolvedCount} late ${resolvedCount === 1 ? 'order was' : 'orders were'} resolved (replacement or refund + Printify decision) and cleared from the list.`
            : `Nothing is overdue. Every shipped order has been delivered within ${threshold} days.`}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                {/* Select-all for the bulk Printify-number copy */}
                <th className="px-2 py-2 text-left font-medium">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={() =>
                      setSelected(
                        allVisibleSelected
                          ? new Set()
                          : new Set(visible.map((o) => o.printifyOrderId))
                      )
                    }
                    title="Select all for bulk copy of Printify numbers"
                    className="h-3.5 w-3.5 accent-indigo-600"
                  />
                </th>
                <th className="px-3 py-2 text-left font-medium">Order</th>
                <th className="px-3 py-2 text-left font-medium">Days</th>
                <th className="px-3 py-2 text-left font-medium">Delivery status</th>
                <th className="px-3 py-2 text-left font-medium">Customer refunded</th>
                <th className="px-3 py-2 text-left font-medium">Refunded by Printify</th>
                <th className="px-3 py-2 text-left font-medium">Notes</th>
                <th className="px-3 py-2 text-left font-medium">Delay email</th>
                <th className="px-3 py-2 text-left font-medium">Links</th>
                <th className="px-3 py-2 text-left font-medium">Done</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visible.map((o) => {
                return (
                  <tr key={o.printifyOrderId} className="hover:bg-gray-50 align-top">
                    <td className="px-2 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(o.printifyOrderId)}
                        onChange={() => toggleSelected(o.printifyOrderId)}
                        title="Tick for bulk copy of Printify numbers"
                        className="h-3.5 w-3.5 accent-indigo-600"
                      />
                    </td>
                    <td className="px-3 py-2 font-medium">
                      <div className="flex items-center gap-1.5">
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
                        <button
                          onClick={() => copyPrintifyNumber(o)}
                          className="inline-flex items-center gap-1 rounded border border-gray-200 bg-white px-1.5 py-0.5 font-mono text-[11px] text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                          title="Click to copy the Printify order number"
                        >
                          <Copy className="w-3 h-3" />
                          {copiedId === o.printifyOrderId
                            ? 'Copied'
                            : o.printifyOrderNumber || 'Printify #'}
                        </button>
                        {o.escalationOpen && (
                          <Link
                            href="/needs-attention"
                            className="inline-flex items-center rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-800 hover:bg-purple-200"
                            title="This order has an open Printify escalation on Needs Attention - work it in one place, not both"
                          >
                            Escalation
                          </Link>
                        )}
                      </div>
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
                    {/* Delivery status doubles as the tracking link - the thing she clicks most */}
                    <td className="px-3 py-2">
                      {o.trackingUrl ? (
                        <a
                          href={o.trackingUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 hover:bg-gray-200 hover:underline"
                          title={o.carrier ? `Track via ${o.carrier}` : 'Track shipment'}
                        >
                          {o.deliveryStatus || 'unknown'}
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                          {o.deliveryStatus || 'unknown'}
                        </span>
                      )}
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
                          <>
                            <YesNo
                              value={
                                o.customerRefunded ??
                                (o.shopifyNoRefund ? false : null)
                              }
                              onChange={(v) => patch(o, { customerRefunded: v })}
                            />
                            {o.customerRefunded == null && o.shopifyNoRefund && (
                              <div
                                className="mt-1 text-[11px] text-gray-500"
                                title="Shopify shows $0 refunded on this order - click Yes to override if the customer was refunded another way"
                              >
                                auto: $0 refunded in Shopify
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                    {/* Refunded by Printify: yes/no (auto-ticked from Printify emails) */}
                    <td className="px-3 py-2">
                      <YesNo
                        value={o.refundedByPrintify}
                        onChange={(v) => patch(o, { refundedByPrintify: v })}
                      />
                      {o.printifyRecovery && (
                        <>
                          <div
                            className={`mt-1 text-[11px] ${
                              o.printifyRecovery.type === 'declined'
                                ? 'text-rose-700'
                                : 'text-emerald-700'
                            }`}
                            title={`Auto-detected from a Printify email on ${fmtDate(
                              o.printifyRecovery.date
                            )}`}
                          >
                            auto: {o.printifyRecovery.type.replace('_', ' ')}
                            {o.printifyRecovery.amountUsd != null
                              ? ` $${o.printifyRecovery.amountUsd.toFixed(2)}`
                              : ''}
                          </div>
                          {/* Printify's own words from the email - e.g. why
                              they did NOT refund. Hover for the full text. */}
                          {o.printifyRecovery.note && (
                            <div
                              className="mt-0.5 max-w-52 text-[11px] italic leading-snug text-gray-500 line-clamp-3"
                              title={o.printifyRecovery.note}
                            >
                              &ldquo;{o.printifyRecovery.note}&rdquo;
                            </div>
                          )}
                          {o.printifyRecovery.ticketUrl && (
                            <a
                              href={o.printifyRecovery.ticketUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] text-gray-500 underline hover:text-gray-700"
                            >
                              Printify ticket <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          )}
                        </>
                      )}
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
                        className="w-40 rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 focus:border-gray-400 focus:outline-none"
                      />
                    </td>
                    {/* Delay email (secondary, always available): draft -> review -> send */}
                    <td className="px-3 py-2">
                      {o.delayEmailedAt ? (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                          <Check className="w-3 h-3" /> Emailed {fmtDate(o.delayEmailedAt)}
                          <button
                            onClick={() => setEmailing({ order: o, template: 'delay-update' })}
                            className="ml-1 text-gray-500 hover:text-gray-700 underline"
                          >
                            again
                          </button>
                        </span>
                      ) : o.customerEmail ? (
                        <button
                          onClick={() => setEmailing({ order: o, template: 'delay-update' })}
                          className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 hover:text-amber-800"
                        >
                          <Mail className="w-3.5 h-3.5" /> Draft email
                        </button>
                      ) : (
                        <span className="text-xs text-gray-400">No email</span>
                      )}
                    </td>
                    {/* Labeled linkouts - big enough to actually hit */}
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <a
                          href={o.printifyUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={linkBtnCls}
                        >
                          Printify <ExternalLink className="w-3 h-3" />
                        </a>
                        {o.shopifyUrl && (
                          <a
                            href={o.shopifyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={linkBtnCls}
                          >
                            Shopify <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                        {o.threadId && (
                          <Link href={`/inbox?thread=${o.threadId}`} className={linkBtnCls}>
                            Thread <Mail className="w-3 h-3" />
                          </Link>
                        )}

                      </div>
                    </td>
                    {/* Manual Done - unlocked once both refund questions are
                        answered (yes or no, manual or auto). Removes the row. */}
                    <td className="px-3 py-2">
                      <button
                        onClick={() => markDone(o)}
                        disabled={!bothQuestionsAnswered(o)}
                        className={`inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs font-medium ${
                          bothQuestionsAnswered(o)
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                            : 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
                        }`}
                        title={
                          bothQuestionsAnswered(o)
                            ? 'Mark this order handled - it drops off the list'
                            : 'Answer both Customer refunded and Refunded by Printify first'
                        }
                      >
                        <Check className="w-3 h-3" /> Done
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Email draft (delay update or refund-or-replacement ask): review and
          edit before it goes anywhere */}
      {emailing && emailing.order.customerEmail && (
        <DelayEmailModal
          orderNumber={emailing.order.orderName}
          customerEmail={emailing.order.customerEmail}
          customerName={emailing.order.customerName}
          template={emailing.template}
          onClose={() => setEmailing(null)}
          onSent={() => recordDelayEmail(emailing.order)}
        />
      )}
    </div>
  );
}
