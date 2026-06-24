'use client';

/**
 * Needs Attention - things that couldn't be auto-handled and need a person.
 * Includes the Printify Escalations section: defect / lost-package cases the
 * operator answered, queued here to action on Printify (replacement or refund)
 * in bulk.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { formatDate } from '@/lib/utils';
import {
  AlertTriangle,
  Sparkles,
  RefreshCcw,
  Check,
  ArrowRight,
  Package,
  ExternalLink,
  Copy,
  Mail,
  Clock,
} from 'lucide-react';

interface AttentionItem {
  type: 'manual' | 'draft_failed' | 'relink_failed';
  id: string;
  threadId?: string | null;
  title: string;
  detail?: string | null;
  createdAt: string;
}

interface Escalation {
  id: string;
  threadId?: string | null;
  orderNumber: string;
  shopifyOrderId?: string | null;
  printifyOrderId?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  resolution: 'REPLACEMENT' | 'REFUND';
  issue: string;
  photoUrls: string[];
  status: 'PENDING' | 'DONE';
  printifyHandled?: boolean;
  printifyHandledAt?: string | null;
  selfHandled?: boolean;
  selfHandledAt?: string | null;
  note?: string | null;
  customerEmailedAt?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
  printifyOrderNumber?: string | null;
  claimWindow?: {
    deadline: string | null;
    daysLeft: number | null;
    status: 'overdue' | 'soon' | 'ok' | 'unknown';
  };
  detected?: { refunded: boolean; replacementSent?: boolean };
}

const TYPE_META = {
  manual: { label: 'Manual', icon: AlertTriangle, className: 'bg-amber-100 text-amber-800' },
  draft_failed: { label: 'Draft failed', icon: Sparkles, className: 'bg-red-100 text-red-700' },
  relink_failed: { label: 'Printify relink', icon: RefreshCcw, className: 'bg-red-100 text-red-700' },
} as const;

export default function NeedsAttentionPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [noteEditingId, setNoteEditingId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');

  const { data, isLoading } = useQuery<{ items: AttentionItem[]; count: number }>({
    queryKey: ['needs-attention'],
    queryFn: async () => {
      const res = await fetch('/api/needs-attention');
      if (!res.ok) throw new Error('Failed to load');
      return res.json();
    },
    refetchInterval: 60000,
  });

  const { data: escData } = useQuery<{
    pending: Escalation[];
    recentlyDone: Escalation[];
    printifyShopId: string | null;
    storeDomain: string | null;
  }>({
    queryKey: ['escalations'],
    queryFn: async () => {
      const res = await fetch('/api/escalations');
      if (!res.ok) throw new Error('Failed to load escalations');
      return res.json();
    },
    refetchInterval: 60000,
  });

  const resolveMutation = useMutation({
    mutationFn: async (threadId: string) => {
      const res = await fetch('/api/needs-attention', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId }),
      });
      if (!res.ok) throw new Error('Failed to resolve');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['needs-attention'] });
      queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
    },
  });

  const escMutation = useMutation({
    mutationFn: async ({
      id,
      status,
      printifyHandled,
      selfHandled,
      note,
      customerEmailed,
    }: {
      id: string;
      status?: 'PENDING' | 'DONE';
      printifyHandled?: boolean;
      selfHandled?: boolean;
      note?: string;
      customerEmailed?: boolean;
    }) => {
      const res = await fetch(`/api/escalations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, printifyHandled, selfHandled, note, customerEmailed }),
      });
      if (!res.ok) throw new Error('Failed to update');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['escalations'] }),
  });

  // Email the customer about their delayed order THROUGH the support desk
  // (sends from the brand mailbox via /api/threads/compose, logs a thread),
  // then records that the email was sent on the escalation.
  const emailDelayMutation = useMutation({
    mutationFn: async (e: Escalation) => {
      if (!e.customerEmail) throw new Error('No customer email on file for this order.');
      const first = e.customerName?.trim().split(/\s+/)[0] || 'there';
      const subject = `Your Summit Soul order ${e.orderNumber} - a quick update`;
      const paras = [
        `Hi ${first},`,
        `I wanted to reach out personally about your order ${e.orderNumber}. It is taking a little longer than expected to reach you, and I am so sorry for the wait.`,
        'We are keeping a close eye on it and will make sure it gets to you. If there is anything I can do in the meantime, just reply to this email.',
        'Thanks so much for your patience!',
        'Best,\nPati | Summit Soul',
      ];
      const bodyText = paras.join('\n\n');
      const bodyHtml = paras
        .map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
        .join('');
      const send = await fetch('/api/threads/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: e.customerEmail,
          toName: e.customerName || undefined,
          subject,
          bodyHtml,
          bodyText,
        }),
      });
      if (!send.ok) {
        const j = await send.json().catch(() => ({}));
        throw new Error(j.error || 'Failed to send the email.');
      }
      const mark = await fetch(`/api/escalations/${e.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerEmailed: true }),
      });
      if (!mark.ok) throw new Error('Email sent, but failed to record it. Refresh and try marking again.');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['escalations'] }),
    onError: (err) => window.alert(err instanceof Error ? err.message : 'Something went wrong.'),
  });

  const items = data?.items || [];
  // Surface escalations whose Printify claim window is closing (or closed) first,
  // so the reship-cost claim gets filed before the 30-day window expires.
  const claimRank = (s?: string) =>
    s === 'overdue' ? 0 : s === 'soon' ? 1 : s === 'ok' ? 2 : 3;
  const pendingEsc = [...(escData?.pending || [])].sort(
    (a, b) => claimRank(a.claimWindow?.status) - claimRank(b.claimWindow?.status)
  );
  const storeDomain = escData?.storeDomain;
  const printifyShopId = escData?.printifyShopId;

  const shopifyUrl = (e: Escalation) =>
    storeDomain && e.shopifyOrderId
      ? `https://${storeDomain}/admin/orders/${e.shopifyOrderId.replace('gid://shopify/Order/', '')}`
      : null;
  const printifyUrl = (e: Escalation) =>
    e.printifyOrderId
      ? printifyShopId
        ? `https://printify.com/app/store/${printifyShopId}/order/${e.printifyOrderId}`
        : `https://printify.com/app/orders/${e.printifyOrderId}`
      : null;

  // Countdown to Printify's 30-day-from-delivery claim deadline. Only shown
  // while the claim is unfiled (not yet handled) and we know the delivery date.
  const claimBadge = (e: Escalation) => {
    const cw = e.claimWindow;
    if (!cw || cw.status === 'unknown' || cw.daysLeft == null) return null;
    if (e.printifyHandled || e.selfHandled) return null;
    const cls =
      cw.status === 'overdue'
        ? 'bg-red-100 text-red-700'
        : cw.status === 'soon'
          ? 'bg-amber-100 text-amber-800'
          : 'bg-gray-100 text-gray-600';
    const label =
      cw.status === 'overdue'
        ? `Claim window closed ${Math.abs(cw.daysLeft)}d ago`
        : `File claim: ${cw.daysLeft}d left`;
    return (
      <span
        className={`inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}
        title="Printify accepts reprint/refund claims within 30 days of delivery"
      >
        <Clock className="w-3 h-3" /> {label}
      </span>
    );
  };

  // A ready-to-send message for Printify support. Reference = the Printify
  // display order number (app_order_id, e.g. "19269685.17804"); falls back to
  // shopId.<shopify-digits> only if the Printify number isn't cached yet.
  const copyInfo = (e: Escalation) => {
    const printifyRef = e.printifyOrderNumber
      ? `#${e.printifyOrderNumber}`
      : printifyShopId
        ? `#${printifyShopId}.${e.orderNumber.replace(/\D/g, '')}`
        : '(not linked)';
    const issue = e.issue.trim().replace(/\s+/g, ' ');
    const text = `Issue: ${issue}\nPrintify order: ${printifyRef}\nShopify order: ${e.orderNumber}`;
    navigator.clipboard?.writeText(text);
    setCopiedId(e.id);
    setTimeout(() => setCopiedId((c) => (c === e.id ? null : c)), 1500);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-2 mb-1">
        <AlertTriangle className="w-5 h-5 text-amber-600" />
        <h1 className="text-xl font-semibold text-gray-900">Needs Attention</h1>
      </div>
      <p className="text-sm text-gray-600 mb-5">
        Things the tool could not finish on its own - Printify escalations,
        manual escalations, failed AI drafts, and failed Printify relinks.
      </p>

      {/* Printify Escalations */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <Package className="w-4 h-4 text-indigo-600" />
          <h2 className="text-sm font-semibold text-gray-900">Printify Escalations</h2>
          {pendingEsc.length > 0 && (
            <span className="text-xs text-gray-500">({pendingEsc.length} to handle)</span>
          )}
        </div>
        {pendingEsc.length === 0 ? (
          <div className="rounded-lg border bg-white px-4 py-5 text-center text-sm text-gray-500">
            No Printify escalations to handle.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50 text-left text-xs font-medium text-gray-500">
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Order</th>
                  <th className="px-3 py-2 font-medium">Issue</th>
                  <th className="px-3 py-2 font-medium">Printify side (replacement / refund)</th>
                  <th className="px-3 py-2 font-medium">Shopify refund (customer)</th>
                  <th className="px-3 py-2 font-medium">Links</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {pendingEsc.map((e) => {
                  const sUrl = shopifyUrl(e);
                  const pUrl = printifyUrl(e);
                  return (
                    <tr key={e.id} className="align-top">
                      {/* Type */}
                      <td className="px-3 py-3">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
                            e.resolution === 'REPLACEMENT'
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-purple-100 text-purple-700'
                          }`}
                        >
                          {e.resolution === 'REPLACEMENT' ? 'Replacement' : 'Refund'}
                        </span>
                      </td>
                      {/* Order */}
                      <td className="px-3 py-3 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">{e.orderNumber}</div>
                        {e.customerName && (
                          <div className="text-xs text-gray-600">{e.customerName}</div>
                        )}
                        <div className="text-xs text-gray-400 mt-0.5">{formatDate(e.createdAt)}</div>
                      </td>
                      {/* Issue */}
                      <td className="px-3 py-3 max-w-[16rem]">
                        <p className="text-xs text-gray-700 break-words">{e.issue}</p>
                        {e.photoUrls.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {e.photoUrls.map((u, i) => (
                              <a key={i} href={u} target="_blank" rel="noreferrer" className="block">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={u}
                                  alt="attachment"
                                  className="w-10 h-10 rounded object-cover border"
                                />
                              </a>
                            ))}
                          </div>
                        )}
                        {/* Operator note */}
                        {noteEditingId === e.id ? (
                          <div className="mt-2">
                            <textarea
                              value={noteDraft}
                              onChange={(ev) => setNoteDraft(ev.target.value)}
                              rows={2}
                              placeholder="e.g. Printify refused, refunded customer ourselves"
                              className="w-full rounded border px-2 py-1 text-xs"
                            />
                            <div className="mt-1 flex gap-2 text-xs">
                              <button
                                onClick={() => {
                                  escMutation.mutate({ id: e.id, note: noteDraft });
                                  setNoteEditingId(null);
                                }}
                                disabled={escMutation.isPending}
                                className="rounded bg-gray-800 px-2 py-0.5 text-white hover:bg-gray-900 disabled:opacity-60"
                              >
                                Save
                              </button>
                              <button
                                onClick={() => setNoteEditingId(null)}
                                className="text-gray-500 hover:text-gray-700"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-2">
                            {e.note && (
                              <p className="text-xs italic text-gray-600 break-words">
                                Note: {e.note}
                              </p>
                            )}
                            <button
                              onClick={() => {
                                setNoteEditingId(e.id);
                                setNoteDraft(e.note || '');
                              }}
                              className="text-xs text-indigo-600 hover:underline"
                            >
                              {e.note ? 'Edit note' : 'Add note'}
                            </button>
                          </div>
                        )}
                      </td>
                      {/* Printify side - manual mark (Printify did it / we did it ourselves) */}
                      <td className="px-3 py-3">
                        <div className="flex flex-col gap-1">
                          {/* Claim-window countdown (Printify's 30-day limit) */}
                          {claimBadge(e)}
                          {/* Auto-detected replacement signal - shown in EVERY state */}
                          {e.detected?.replacementSent && (
                            <span className="inline-flex w-fit items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700">
                              <Check className="w-3 h-3" /> Replacement detected
                            </span>
                          )}
                          {e.printifyHandled ? (
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-700 font-medium">
                              <Check className="w-3.5 h-3.5" />
                              {e.resolution === 'REPLACEMENT'
                                ? 'Replacement created'
                                : 'Refunded on Printify'}
                              <button
                                onClick={() =>
                                  escMutation.mutate({ id: e.id, printifyHandled: false })
                                }
                                disabled={escMutation.isPending}
                                className="ml-1 text-gray-400 hover:text-gray-600 underline"
                              >
                                undo
                              </button>
                            </span>
                          ) : e.selfHandled ? (
                            <span className="inline-flex items-center gap-1 text-xs text-amber-700 font-medium">
                              <Check className="w-3.5 h-3.5" />
                              We handled it (Printify declined)
                              <button
                                onClick={() =>
                                  escMutation.mutate({ id: e.id, selfHandled: false })
                                }
                                disabled={escMutation.isPending}
                                className="ml-1 text-gray-400 hover:text-gray-600 underline"
                              >
                                undo
                              </button>
                            </span>
                          ) : (
                            <>
                              <button
                                onClick={() =>
                                  escMutation.mutate({ id: e.id, printifyHandled: true })
                                }
                                disabled={escMutation.isPending}
                                className="inline-flex w-fit items-center gap-1 rounded border border-indigo-300 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-60"
                              >
                                {e.resolution === 'REPLACEMENT'
                                  ? 'Mark replacement created'
                                  : 'Mark refunded on Printify'}
                              </button>
                              <button
                                onClick={() => escMutation.mutate({ id: e.id, selfHandled: true })}
                                disabled={escMutation.isPending}
                                className="inline-flex w-fit items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-60"
                              >
                                We handled it ourselves
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                      {/* Customer Shopify refund - auto-detected */}
                      <td className="px-3 py-3 whitespace-nowrap">
                        {e.detected?.refunded ? (
                          <span className="inline-flex items-center gap-1 text-xs text-emerald-700 font-medium">
                            <Check className="w-3.5 h-3.5" /> Refunded
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">Not refunded</span>
                        )}
                      </td>
                      {/* Links */}
                      <td className="px-3 py-3">
                        <div className="flex flex-col gap-1 text-xs">
                          {sUrl && (
                            <a
                              href={sUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-600 hover:text-blue-700 inline-flex items-center gap-1"
                            >
                              Shopify <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                          {pUrl && (
                            <a
                              href={pUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-1"
                            >
                              Printify <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                          <button
                            onClick={() => copyInfo(e)}
                            className="text-gray-600 hover:text-gray-800 inline-flex items-center gap-1"
                          >
                            <Copy className="w-3 h-3" /> {copiedId === e.id ? 'Copied' : 'Copy for Printify'}
                          </button>
                          {e.threadId && (
                            <button
                              onClick={() => router.push(`/inbox?thread=${e.threadId}`)}
                              className="text-gray-600 hover:text-gray-800 inline-flex items-center gap-1"
                            >
                              <Mail className="w-3 h-3" /> Open thread
                            </button>
                          )}
                          {/delay/i.test(e.issue) && e.customerEmail && (
                            e.customerEmailedAt ? (
                              <span className="inline-flex items-center gap-1 text-emerald-700">
                                <Check className="w-3 h-3" /> Emailed {formatDate(e.customerEmailedAt)}
                                <button
                                  onClick={() => emailDelayMutation.mutate(e)}
                                  disabled={emailDelayMutation.isPending}
                                  className="ml-1 text-gray-500 hover:text-gray-700 underline disabled:opacity-60"
                                >
                                  send again
                                </button>
                              </span>
                            ) : (
                              <button
                                onClick={() => emailDelayMutation.mutate(e)}
                                disabled={emailDelayMutation.isPending}
                                className="text-amber-700 hover:text-amber-800 inline-flex items-center gap-1 font-medium disabled:opacity-60"
                              >
                                <Mail className="w-3 h-3" />
                                {emailDelayMutation.isPending &&
                                emailDelayMutation.variables?.id === e.id
                                  ? 'Sending...'
                                  : 'Email about delay'}
                              </button>
                            )
                          )}
                        </div>
                      </td>
                      {/* Mark done */}
                      <td className="px-3 py-3">
                        <button
                          onClick={() => escMutation.mutate({ id: e.id, status: 'DONE' })}
                          disabled={escMutation.isPending}
                          className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-60 whitespace-nowrap"
                        >
                          <Check className="w-3 h-3" /> Mark done
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Other attention items */}
      <h2 className="text-sm font-semibold text-gray-900 mb-2">Other</h2>
      {isLoading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border bg-white p-6 text-center">
          <Check className="w-7 h-7 text-emerald-500 mx-auto mb-2" />
          <p className="text-sm text-gray-600">All clear - nothing else needs attention.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => {
            const meta = TYPE_META[item.type];
            const Icon = meta.icon;
            return (
              <li
                key={item.id}
                className="rounded-lg border bg-white px-4 py-3 flex items-start gap-3"
              >
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 mt-0.5 ${meta.className}`}>
                  <Icon className="w-3 h-3" />
                  {meta.label}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900">{item.title}</p>
                  {item.detail && (
                    <p className="text-xs text-gray-600 mt-0.5 break-words">{item.detail}</p>
                  )}
                  <p className="text-xs text-gray-400 mt-0.5">{formatDate(item.createdAt)}</p>
                </div>
                <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                  {item.threadId && (
                    <button
                      onClick={() => router.push(`/inbox?thread=${item.threadId}`)}
                      className="text-xs text-blue-600 hover:text-blue-700 inline-flex items-center gap-1"
                    >
                      Open <ArrowRight className="w-3 h-3" />
                    </button>
                  )}
                  {item.type === 'manual' && item.threadId && (
                    <button
                      onClick={() => resolveMutation.mutate(item.threadId!)}
                      disabled={resolveMutation.isPending}
                      className="text-xs text-emerald-700 hover:text-emerald-800 inline-flex items-center gap-1"
                    >
                      <Check className="w-3 h-3" /> Resolve
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
