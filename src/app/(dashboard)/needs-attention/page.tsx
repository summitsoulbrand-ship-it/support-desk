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
  createdAt: string;
  resolvedAt?: string | null;
  printifyOrderNumber?: string | null;
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
    }: {
      id: string;
      status?: 'PENDING' | 'DONE';
      printifyHandled?: boolean;
    }) => {
      const res = await fetch(`/api/escalations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, printifyHandled }),
      });
      if (!res.ok) throw new Error('Failed to update');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['escalations'] }),
  });

  const items = data?.items || [];
  const pendingEsc = escData?.pending || [];
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

  // A ready-to-send message for Printify support. Reference = the Printify
  // display order number (app_order_id, e.g. "19269685.17804"); falls back to
  // shopId.<shopify-digits> only if the Printify number isn't cached yet.
  const copyInfo = (e: Escalation) => {
    const ref = e.printifyOrderNumber
      ? `#${e.printifyOrderNumber}`
      : printifyShopId
        ? `#${printifyShopId}.${e.orderNumber.replace(/\D/g, '')}`
        : e.orderNumber;
    const action =
      e.resolution === 'REPLACEMENT'
        ? 'Would you be able to send a replacement?'
        : 'Would you be able to issue a refund?';
    const issue = e.issue.trim().replace(/\s+/g, ' ');
    const text = `Hi there! Hope you're doing well. I have an order that needs a little help - the customer reported: ${issue} (order ${ref}). ${action} Thank you so much, I really appreciate it!`;
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
                      </td>
                      {/* Printify side - manual mark (replacement created / refunded on Printify) */}
                      <td className="px-3 py-3">
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
                        ) : (
                          <div className="flex flex-col gap-1">
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
                            {e.detected?.replacementSent && (
                              <span className="text-xs text-emerald-700">reprint detected</span>
                            )}
                          </div>
                        )}
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
