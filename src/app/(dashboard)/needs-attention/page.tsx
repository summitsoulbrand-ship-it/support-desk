'use client';

/**
 * Needs Attention - things that couldn't be auto-handled and need a person.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { formatDate } from '@/lib/utils';
import { AlertTriangle, Sparkles, RefreshCcw, Check, ArrowRight } from 'lucide-react';

interface AttentionItem {
  type: 'manual' | 'draft_failed' | 'relink_failed';
  id: string;
  threadId?: string | null;
  title: string;
  detail?: string | null;
  createdAt: string;
}

const TYPE_META = {
  manual: { label: 'Manual', icon: AlertTriangle, className: 'bg-amber-100 text-amber-800' },
  draft_failed: { label: 'Draft failed', icon: Sparkles, className: 'bg-red-100 text-red-700' },
  relink_failed: { label: 'Printify relink', icon: RefreshCcw, className: 'bg-red-100 text-red-700' },
} as const;

export default function NeedsAttentionPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ items: AttentionItem[]; count: number }>({
    queryKey: ['needs-attention'],
    queryFn: async () => {
      const res = await fetch('/api/needs-attention');
      if (!res.ok) throw new Error('Failed to load');
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

  const items = data?.items || [];

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 mb-1">
        <AlertTriangle className="w-5 h-5 text-amber-600" />
        <h1 className="text-xl font-semibold text-gray-900">Needs Attention</h1>
        {items.length > 0 && (
          <span className="ml-1 text-sm font-normal text-gray-500">({items.length})</span>
        )}
      </div>
      <p className="text-sm text-gray-600 mb-5">
        Things the tool could not finish on its own - manual escalations, failed
        AI drafts, and failed Printify relinks.
      </p>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border bg-white p-8 text-center">
          <Check className="w-8 h-8 text-emerald-500 mx-auto mb-2" />
          <p className="text-sm text-gray-600">All clear - nothing needs attention.</p>
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
