'use client';

/**
 * Inbox list component - displays list of threads
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query';
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { cn, formatDate, truncate } from '@/lib/utils';
import { useAutoSync } from '@/hooks/use-auto-sync';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useInboxShortcuts } from '@/hooks/use-inbox-shortcuts';
import { useSendErrors, dismissSendError } from '@/hooks/use-send-errors';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ComposeModal } from '@/components/compose/compose-modal';
import {
  Inbox,
  CheckCircle,
  Search,
  RefreshCw,
  Trash2,
  Palette,
  PenSquare,
  AlertTriangle,
  X,
} from 'lucide-react';

interface Tag {
  id: string;
  name: string;
  color: string;
}

interface Thread {
  id: string;
  subject: string;
  customerEmail: string;
  customerName: string | null;
  status: 'OPEN' | 'PENDING' | 'CLOSED' | 'TRASHED';
  lastMessageAt: string;
  messageCount: number;
  assignedUser: {
    id: string;
    name: string;
    email: string;
  } | null;
  preview: string | null;
  latestMessageAt: string | null;
  tags?: Tag[];
  triage?: {
    intent: string;
    confidence: number;
    entities?: { sentiment?: string } | null;
  } | null;
  priority?: number;
  aiDraft?: { status: 'PENDING' | 'READY' | 'FAILED' | 'STALE' | 'AWAITING_ACTION' } | null;
}

interface ThreadsPageResponse {
  threads: Thread[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ['threads'] cache entries can be the infinite { pages } shape (this list)
// or the flat { threads } shape (threads-open mirror). This maps both.
type ThreadsCacheData =
  | { threads?: Thread[]; pages?: undefined }
  | { pages: { threads?: Thread[] }[]; pageParams?: unknown[] };

function filterThreadsCache(
  data: ThreadsCacheData | undefined,
  keep: (t: Thread) => boolean
): ThreadsCacheData | undefined {
  if (!data) return data;
  if ('pages' in data && data.pages) {
    return {
      ...data,
      pages: data.pages.map((p) =>
        p.threads ? { ...p, threads: p.threads.filter(keep) } : p
      ),
    };
  }
  if (!data.threads) return data;
  return { ...data, threads: data.threads.filter(keep) };
}

const INTENT_BADGES: Record<string, { label: string; className: string }> = {
  SIZE_EXCHANGE: { label: 'Size', className: 'bg-purple-100 text-purple-800' },
  SHIPPING_STATUS: { label: 'Shipping', className: 'bg-blue-100 text-blue-800' },
  ADDRESS_UPDATE: { label: 'Address', className: 'bg-amber-100 text-amber-800' },
  CANCELLATION: { label: 'Cancel', className: 'bg-red-100 text-red-800' },
  ORDER_ISSUE: { label: 'Issue', className: 'bg-rose-100 text-rose-800' },
  RETURN_REFUND: { label: 'Refund', className: 'bg-orange-100 text-orange-800' },
  DISCOUNT: { label: 'Discount', className: 'bg-pink-100 text-pink-800' },
  PRODUCT_QUESTION: { label: 'Question', className: 'bg-teal-100 text-teal-800' },
  POSITIVE_FEEDBACK: { label: 'Praise', className: 'bg-emerald-100 text-emerald-800' },
  UNSUBSCRIBE: { label: 'Suppress', className: 'bg-rose-100 text-rose-800' },
  WHOLESALE: { label: 'Wholesale', className: 'bg-indigo-100 text-indigo-800' },
  SPAM: { label: 'Spam', className: 'bg-gray-100 text-gray-500' },
};

interface InboxListProps {
  selectedThreadId?: string;
  onSelectThread: (threadId: string) => void;
}

// The Trash tab is gone - the nav's Trash page (bulk restore/purge) is the
// canonical surface for trashed threads.
type FilterType = 'all' | 'closed' | 'design';

const PAGE_SIZE = 20;

export function InboxList({ selectedThreadId, onSelectThread }: InboxListProps) {
  const [filter, setFilter] = useState<FilterType>('all');
  const [sort, setSort] = useState<'priority' | 'newest'>('priority');
  const [searchQuery, setSearchQuery] = useState('');
  // Debounced copy feeds the query key so we don't fetch per keystroke
  const debouncedSearch = useDebouncedValue(searchQuery, 300);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  // Multi-select for bulk actions
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastCheckedIndexRef = useRef<number | null>(null);
  const queryClient = useQueryClient();

  // Background send failures (Send & Close runs in a queue) - persistent,
  // dismissible, visible no matter which thread is open.
  const sendErrors = useSendErrors();

  // Enable automatic background sync
  const { isEmailSyncing, lastEmailSyncResult } = useAutoSync();
  const [showSyncResult, setShowSyncResult] = useState(false);

  // Show sync result briefly after sync completes
  useEffect(() => {
    if (lastEmailSyncResult && !isEmailSyncing) {
      setShowSyncResult(true);
      const timer = setTimeout(() => setShowSyncResult(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [lastEmailSyncResult, isEmailSyncing]);

  // Open-email count for the header (shared cache with the nav badges)
  const { data: navCounts } = useQuery<{ emails?: number }>({
    queryKey: ['nav-counts'],
    queryFn: async () => {
      const res = await fetch('/api/nav/counts');
      if (!res.ok) return {};
      return res.json();
    },
    refetchInterval: 60000,
  });

  const {
    data,
    isLoading,
    isError,
    refetch,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['threads', filter, debouncedSearch, sort],
    queryFn: async ({ pageParam }): Promise<ThreadsPageResponse> => {
      const params = new URLSearchParams();
      if (filter === 'closed') params.set('status', 'CLOSED');
      else if (filter === 'design') params.set('tag', 'Design');
      // Default 'all' shows only OPEN and PENDING (not CLOSED)

      // Priority queue only makes sense for the open inbox
      if (filter === 'all' && sort === 'priority') params.set('sort', 'priority');

      if (debouncedSearch) params.set('search', debouncedSearch);
      params.set('page', String(pageParam));
      params.set('limit', String(PAGE_SIZE));

      const res = await fetch(`/api/threads?${params}`);
      if (!res.ok) throw new Error('Failed to fetch threads');
      return res.json();
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.pagination &&
      lastPage.pagination.page < lastPage.pagination.totalPages
        ? lastPage.pagination.page + 1
        : undefined,
    staleTime: 10000, // Consider data fresh for 10 seconds
    // Refetching an infinite query re-fetches EVERY loaded page, so the 30s
    // poll only runs while just page 1 is loaded. Once the operator pages
    // deeper it pauses (window focus / manual sync still refresh).
    refetchInterval: (query) =>
      (query.state.data?.pages.length ?? 1) > 1 ? false : 30000,
    refetchIntervalInBackground: false, // Don't poll when tab is hidden
    refetchOnWindowFocus: true,
    // Keep the previous list on screen while a new search/filter loads
    placeholderData: keepPreviousData,
  });

  const threads: Thread[] = useMemo(
    () => data?.pages.flatMap((p) => p.threads || []) ?? [],
    [data]
  );

  // Cache the default threads list (flattened) for quick access - the
  // thread view's next-open-thread navigation reads this shape.
  useEffect(() => {
    if (data && filter === 'all' && debouncedSearch.trim() === '') {
      queryClient.setQueryData(['threads-open'], { threads });
    }
  }, [data, threads, filter, debouncedSearch, queryClient]);

  // Selection only makes sense within one view of the list
  useEffect(() => {
    setSelectedIds(new Set());
    lastCheckedIndexRef.current = null;
  }, [filter, debouncedSearch, sort]);

  // Header count: prefer the total from the same response that feeds the
  // list (so the badge can never disagree with what's shown); fall back to
  // the nav-counts poll when filtered/searching.
  const listTotal = data?.pages[0]?.pagination?.total;
  const inboxCount =
    filter === 'all' && !debouncedSearch && typeof listTotal === 'number'
      ? listTotal
      : navCounts?.emails;

  // j / k move the selection through the list (and open the thread)
  const moveSelection = useCallback(
    (delta: 1 | -1) => {
      if (threads.length === 0) return;
      const idx = threads.findIndex((t) => t.id === selectedThreadId);
      const nextIdx =
        idx === -1
          ? delta > 0
            ? 0
            : threads.length - 1
          : Math.min(threads.length - 1, Math.max(0, idx + delta));
      const next = threads[nextIdx];
      if (next && next.id !== selectedThreadId) onSelectThread(next.id);
    },
    [threads, selectedThreadId, onSelectThread]
  );
  useInboxShortcuts({
    onNext: () => moveSelection(1),
    onPrev: () => moveSelection(-1),
  });

  // Bulk close / trash. The /api/threads/bulk endpoint only supports
  // restore / purge / merge, so this reuses the per-thread PATCH contract
  // (same one the thread view's status buttons use) in parallel.
  const bulkStatusMutation = useMutation({
    mutationFn: async ({
      ids,
      status,
    }: {
      ids: string[];
      status: 'CLOSED' | 'TRASHED';
    }) => {
      const results = await Promise.allSettled(
        ids.map((id) =>
          fetch(`/api/threads/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status }),
          }).then((res) => {
            if (!res.ok) throw new Error('Failed to update thread');
          })
        )
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        throw new Error(`${failed} of ${ids.length} threads failed to update`);
      }
    },
    // Optimistically drop the rows from every threads view; the invalidate
    // on settle reconciles with the server (and restores any failures).
    onMutate: async ({ ids }) => {
      await queryClient.cancelQueries({ queryKey: ['threads'] });
      const idSet = new Set(ids);
      const snapshots = queryClient.getQueriesData<ThreadsCacheData>({
        queryKey: ['threads'],
      });
      for (const [key, cached] of snapshots) {
        queryClient.setQueryData(
          key,
          filterThreadsCache(cached, (t) => !idSet.has(t.id))
        );
      }
      queryClient.setQueryData<{ threads?: Thread[] }>(
        ['threads-open'],
        (cached) =>
          cached?.threads
            ? { ...cached, threads: cached.threads.filter((t) => !idSet.has(t.id)) }
            : cached
      );
      setSelectedIds(new Set());
      lastCheckedIndexRef.current = null;
      return { snapshots };
    },
    onError: (_err, _vars, context) => {
      for (const [key, cached] of context?.snapshots ?? []) {
        queryClient.setQueryData(key, cached);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
    },
  });

  // Checkbox click with shift-range support
  const handleToggleSelect = (
    thread: Thread,
    index: number,
    shiftKey: boolean
  ) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const last = lastCheckedIndexRef.current;
      if (shiftKey && last !== null && last !== index) {
        const [from, to] = last < index ? [last, index] : [index, last];
        const turnOn = !prev.has(thread.id);
        for (let i = from; i <= to; i++) {
          const t = threads[i];
          if (!t) continue;
          if (turnOn) next.add(t.id);
          else next.delete(t.id);
        }
      } else if (next.has(thread.id)) {
        next.delete(thread.id);
      } else {
        next.add(thread.id);
      }
      return next;
    });
    lastCheckedIndexRef.current = index;
  };

  const handleSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      // Sync emails and Printify orders in parallel
      await Promise.all([
        fetch('/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
        fetch('/api/admin/printify/sync', {
          method: 'POST',
        }),
      ]);
      // Invalidate Printify sync status
      queryClient.invalidateQueries({ queryKey: ['printify-sync-status'] });
    } catch {
      // Ignore sync errors; still refetch threads list
    } finally {
      await refetch();
      setIsSyncing(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'OPEN':
        return <Badge variant="success">Open</Badge>;
      case 'PENDING':
        return <Badge variant="warning">Pending</Badge>;
      case 'CLOSED':
        return <Badge variant="default">Closed</Badge>;
      case 'TRASHED':
        return <Badge variant="default">Trash</Badge>;
      default:
        return null;
    }
  };

  const filters: { key: FilterType; label: string; icon: React.ReactNode }[] = [
    { key: 'all', label: 'All', icon: <Inbox className="w-4 h-4" /> },
    { key: 'design', label: 'Design', icon: <Palette className="w-4 h-4" /> },
    { key: 'closed', label: 'Closed', icon: <CheckCircle className="w-4 h-4" /> },
  ];

  const remaining =
    typeof listTotal === 'number' ? Math.max(0, listTotal - threads.length) : 0;

  return (
    <div className="flex flex-col h-full bg-white border-r">
      {/* Compose Modal */}
      <ComposeModal
        isOpen={isComposeOpen}
        onClose={() => setIsComposeOpen(false)}
        onSuccess={(threadId) => {
          onSelectThread(threadId);
        }}
      />

      {/* Header */}
      <div className="p-4 border-b">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            Inbox
            {typeof inboxCount === 'number' && (
              <span className="ml-1.5 text-base font-normal text-gray-500">
                ({inboxCount})
              </span>
            )}
          </h2>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsComposeOpen(true)}
              title="Compose new email"
            >
              <PenSquare className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSync}
              disabled={isFetching || isSyncing}
              title="Sync emails"
            >
              <RefreshCw
                className={cn(
                  'w-4 h-4',
                  (isFetching || isSyncing) && 'animate-spin'
                )}
              />
            </Button>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search threads..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 rounded-lg bg-white text-gray-900 placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Sync progress indicator */}
        {isEmailSyncing && (
          <div className="flex items-center gap-2 mt-3 px-2 py-1.5 bg-blue-50 rounded-md">
            <RefreshCw className="w-3 h-3 text-blue-600 animate-spin" />
            <span className="text-xs text-blue-700">Syncing emails...</span>
          </div>
        )}
        {showSyncResult && lastEmailSyncResult && !isEmailSyncing && (
          <div className="flex items-center gap-2 mt-3 px-2 py-1.5 bg-green-50 rounded-md">
            <CheckCircle className="w-3 h-3 text-green-600" />
            <span className="text-xs text-green-700">
              {lastEmailSyncResult.messagesProcessed > 0
                ? `Synced ${lastEmailSyncResult.messagesProcessed} new email${lastEmailSyncResult.messagesProcessed > 1 ? 's' : ''}`
                : 'No new emails'}
            </span>
          </div>
        )}
      </div>

      {/* Background send failures - the reply is kept as a draft on the
          thread, so nothing is lost */}
      {sendErrors.length > 0 && (
        <div className="border-b">
          {sendErrors.map((err) => (
            <div
              key={err.id}
              className={cn(
                'flex items-start gap-2 px-3 py-2 text-xs',
                err.ambiguous ? 'bg-amber-50 text-amber-900' : 'bg-red-50 text-red-800'
              )}
            >
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                {err.ambiguous ? (
                  <>
                    <p className="font-medium truncate">
                      Couldn&apos;t confirm send: {err.subject}
                    </p>
                    <p className="text-amber-800">
                      The connection dropped, so we didn&apos;t hear back - but the
                      reply may have gone out anyway. Open the thread and check the
                      last reply: if it shows &quot;Sent&quot; it reached the
                      customer, if it shows &quot;Not sent&quot; send it again.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-medium truncate">
                      Send failed: {err.subject}
                    </p>
                    <p className="text-red-700">
                      {err.message} - the reply was kept as a draft on the thread.
                    </p>
                  </>
                )}
                <button
                  onClick={() => onSelectThread(err.threadId)}
                  className={cn(
                    'mt-0.5 font-medium underline hover:no-underline',
                    err.ambiguous ? 'text-amber-900' : ''
                  )}
                >
                  Open thread
                </button>
              </div>
              <button
                onClick={() => dismissSendError(err.id)}
                className="text-red-400 hover:text-red-700 flex-shrink-0"
                title="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex border-b overflow-x-auto">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2 text-sm font-medium whitespace-nowrap',
              'border-b-2 transition-colors',
              filter === f.key
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            )}
          >
            {f.icon}
            {f.label}
          </button>
        ))}
        {filter === 'all' && (
          <button
            onClick={() => setSort(sort === 'priority' ? 'newest' : 'priority')}
            className="ml-auto px-3 py-2 text-xs text-gray-500 hover:text-gray-800 whitespace-nowrap"
            title={
              sort === 'priority'
                ? 'Sorted by urgency: cancellations, upset customers and address changes first. Click for newest-first.'
                : 'Sorted newest-first. Click for priority order.'
            }
          >
            {sort === 'priority' ? '⚡ Priority' : '🕐 Newest'}
          </button>
        )}
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-blue-50">
          <span className="text-xs font-medium text-blue-900">
            {selectedIds.size} selected
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                bulkStatusMutation.mutate({
                  ids: [...selectedIds],
                  status: 'CLOSED',
                })
              }
              disabled={bulkStatusMutation.isPending}
            >
              <CheckCircle className="w-4 h-4 mr-1" />
              Close
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                bulkStatusMutation.mutate({
                  ids: [...selectedIds],
                  status: 'TRASHED',
                })
              }
              disabled={bulkStatusMutation.isPending}
            >
              <Trash2 className="w-4 h-4 mr-1" />
              Trash
            </Button>
            <button
              onClick={() => {
                setSelectedIds(new Set());
                lastCheckedIndexRef.current = null;
              }}
              className="text-xs text-gray-500 hover:text-gray-800 px-1"
            >
              Clear
            </button>
          </div>
        </div>
      )}
      {bulkStatusMutation.isError && (
        <div className="px-3 py-1.5 border-b bg-red-50 text-xs text-red-700">
          {(bulkStatusMutation.error as Error).message}
        </div>
      )}

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-32">
            <RefreshCw className="w-6 h-6 text-gray-400 animate-spin" />
          </div>
        ) : isError && threads.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-gray-500">
            <Inbox className="w-8 h-8 mb-2" />
            <p className="text-sm">Could not load threads</p>
            <button
              onClick={() => refetch()}
              className="mt-2 text-xs text-blue-600 hover:underline"
            >
              Try again
            </button>
          </div>
        ) : threads.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-gray-500">
            <Inbox className="w-8 h-8 mb-2" />
            <p className="text-sm">No threads found</p>
          </div>
        ) : (
          <>
            <ul className="divide-y">
              {threads.map((thread, index) => (
                <li key={thread.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectThread(thread.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectThread(thread.id);
                      }
                    }}
                    className={cn(
                      'w-full text-left p-4 hover:bg-gray-50 transition-colors cursor-pointer',
                      selectedThreadId === thread.id && 'bg-blue-50',
                      selectedIds.has(thread.id) && 'bg-blue-50/60'
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex flex-col items-center gap-1.5">
                        <Avatar
                          name={thread.customerName || thread.customerEmail}
                          size="sm"
                        />
                        <input
                          type="checkbox"
                          checked={selectedIds.has(thread.id)}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleSelect(
                              thread,
                              index,
                              (e.nativeEvent as MouseEvent).shiftKey
                            );
                          }}
                          onChange={() => {
                            // handled in onClick (needs shiftKey)
                          }}
                          onKeyDown={(e) => e.stopPropagation()}
                          className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                          title="Select for bulk actions (shift-click for a range)"
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-gray-900 truncate">
                            {thread.customerName || thread.customerEmail}
                            {thread.messageCount > 1 && (
                              <span className="ml-1 text-gray-500 font-normal">
                                ({thread.messageCount})
                              </span>
                            )}
                          </span>
                          <span className="text-xs text-gray-500 whitespace-nowrap">
                            {formatDate(thread.lastMessageAt)}
                          </span>
                        </div>
                        <p className="text-sm font-medium text-gray-800 truncate">
                          {thread.subject}
                        </p>
                        <p className="text-sm text-gray-500 truncate">
                          {thread.preview
                            ? truncate(thread.preview, 60)
                            : 'No preview available'}
                        </p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          {getStatusBadge(thread.status)}
                          {thread.triage &&
                            (thread.triage.entities?.sentiment === 'angry' ||
                              thread.triage.entities?.sentiment === 'frustrated') && (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-red-600 text-white">
                                Upset
                              </span>
                            )}
                          {thread.triage && INTENT_BADGES[thread.triage.intent] && (
                            <span
                              className={cn(
                                'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium',
                                INTENT_BADGES[thread.triage.intent].className
                              )}
                            >
                              {INTENT_BADGES[thread.triage.intent].label}
                            </span>
                          )}
                          {thread.aiDraft?.status === 'READY' &&
                            (thread.status === 'OPEN' || thread.status === 'PENDING') &&
                            (thread.triage?.intent === 'POSITIVE_FEEDBACK' ? (
                              <span
                                className="inline-flex items-center gap-1 text-xs text-gray-500"
                                title="Thank-you message - no reply needed, just close it"
                              >
                                <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                                No reply needed
                              </span>
                            ) : (
                              <span
                                className="inline-flex items-center gap-1 text-xs text-emerald-700"
                                title="AI reply draft is ready"
                              >
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                Draft ready
                              </span>
                            ))}
                          {thread.tags?.map((tag) => (
                            <span
                              key={tag.id}
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium"
                              style={{
                                backgroundColor: `${tag.color}20`,
                                color: tag.color,
                              }}
                            >
                              {tag.name}
                            </span>
                          ))}
                          {thread.assignedUser && (
                            <span className="text-xs text-gray-500">
                              {thread.assignedUser.name}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            {/* Load more */}
            {hasNextPage && (
              <div className="p-3 text-center border-t">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                  loading={isFetchingNextPage}
                >
                  Load more{remaining > 0 ? ` (${remaining} left)` : ''}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Keyboard shortcut hints */}
      <div className="border-t px-3 py-1.5 text-[10px] text-gray-400 whitespace-nowrap overflow-hidden text-ellipsis">
        j/k navigate &middot; e close &middot; # trash &middot; s snooze &middot; r reply
      </div>
    </div>
  );
}
