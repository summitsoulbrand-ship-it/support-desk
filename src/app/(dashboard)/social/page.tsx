'use client';

/**
 * Social Comments Page
 * Main view for managing Facebook and Instagram comments
 */

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SocialCommentList } from '@/components/social/comment-list';
import { SocialCommentDetail } from '@/components/social/comment-detail';
import { ConversationsView } from '@/components/social/conversations-view';
import { SocialFilters, type SocialFilterState } from '@/components/social/filters';
import { Button } from '@/components/ui/button';
import { RefreshCw, Settings, AlertCircle, MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

export default function SocialPage() {
  const [view, setView] = useState<'comments' | 'messages'>('comments');
  // Open = needs attention; Done = handled (liked/replied/hidden/aged out)
  const [listTab, setListTab] = useState<'open' | 'done'>('open');
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);
  const [filters, setFilters] = useState<SocialFilterState>({
    platforms: [],
    accountIds: [],
    status: [],
    hidden: undefined,
    hasReply: undefined,
    isAd: undefined,
    search: '',
  });

  // Tab counts so an empty Open tab reads as "all handled", not "broken"
  const { data: tabCounts } = useQuery({
    queryKey: ['social-comment-counts'],
    queryFn: async () => {
      const [open, done] = await Promise.all([
        fetch('/api/social/comments?status=NEW,IN_PROGRESS,ESCALATED&limit=1').then(
          (r) => r.json()
        ),
        fetch('/api/social/comments?status=DONE&limit=1').then((r) => r.json()),
      ]);
      return {
        open: open.pagination?.total ?? 0,
        done: done.pagination?.total ?? 0,
      };
    },
    refetchInterval: 60000,
  });

  // Open DM count (real DMs only - the API already excludes comment mirrors)
  const { data: dmCounts } = useQuery({
    queryKey: ['social-dm-counts'],
    queryFn: async () => {
      const res = await fetch('/api/social/conversations');
      if (!res.ok) return { open: 0 };
      const data = await res.json();
      const open = (data.conversations || []).filter(
        (c: { status: string }) => c.status !== 'DONE'
      ).length;
      return { open };
    },
    refetchInterval: 60000,
  });

  // Check if Meta is connected
  const { data: authData, isLoading: authLoading } = useQuery({
    queryKey: ['social-auth'],
    queryFn: async () => {
      const res = await fetch('/api/social/auth');
      if (!res.ok) throw new Error('Failed to fetch auth status');
      return res.json();
    },
  });

  // Get sync status
  const { data: syncData, refetch: refetchSync } = useQuery({
    queryKey: ['social-sync-status'],
    queryFn: async () => {
      const res = await fetch('/api/social/sync');
      if (!res.ok) throw new Error('Failed to fetch sync status');
      return res.json();
    },
    refetchInterval: 60000, // Refresh every minute
    refetchIntervalInBackground: false, // Don't poll when tab is hidden
  });

  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await fetch('/api/social/sync', { method: 'POST' });
      refetchSync();
    } catch (err) {
      console.error('Sync failed:', err);
    } finally {
      setSyncing(false);
    }
  };

  // Next open comment in the current list order, relative to a given one
  const findNextOpenId = (fromId: string): string | null => {
    const queries = queryClientRef.getQueriesData<{
      comments?: Array<{ id: string; status: string }>;
    }>({ queryKey: ['social-comments'] });
    let list: Array<{ id: string; status: string }> = [];
    for (const [, data] of queries) {
      if (data?.comments?.some((c) => c.id === fromId)) {
        list = data.comments;
        break;
      }
      if (!list.length && data?.comments?.length) list = data.comments;
    }
    const isOpen = (c: { id: string; status: string }) =>
      c.id !== fromId && ['NEW', 'IN_PROGRESS', 'ESCALATED'].includes(c.status);
    const idx = list.findIndex((c) => c.id === fromId);
    const next =
      (idx >= 0 ? list.slice(idx + 1).find(isOpen) : undefined) ||
      (idx > 0 ? [...list.slice(0, idx)].reverse().find(isOpen) : undefined) ||
      list.find(isOpen);
    return next ? next.id : null;
  };

  // After resolving the selected comment (like/reply/hide/done), jump to the
  // next open one in the current list order - same flow as the email inbox
  const handleCommentResolved = (resolvedId: string) => {
    if (resolvedId !== selectedCommentId) return;
    setSelectedCommentId(findNextOpenId(resolvedId));
  };

  // Prefetch the likely-next comment's thread while the current one is being
  // worked on - advancing then renders instantly from cache
  useEffect(() => {
    if (!selectedCommentId) return;
    const nextId = findNextOpenId(selectedCommentId);
    if (!nextId) return;
    queryClientRef.prefetchQuery({
      queryKey: ['social-comment', nextId],
      queryFn: async () => {
        const res = await fetch(`/api/social/comments/${nextId}`);
        if (!res.ok) throw new Error('Failed to fetch comment');
        return res.json();
      },
      staleTime: 30_000,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCommentId]);

  // Bulk-like the friend-tag comments: loops the batch endpoint until none
  // remain; a like acknowledges the tag and closes the comment.
  const [bulkLiking, setBulkLiking] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const queryClientRef = useQueryClient();
  const handleBulkLikeTags = async () => {
    if (bulkLiking) return;
    if (!window.confirm('Like and close all open friend-tag and clearly positive comments (\'I need this shirt\', \'Love it\'...)? Questions and anything negative are skipped.')) return;
    setBulkLiking(true);
    setBulkProgress('Starting...');
    let total = 0;
    let consecutiveFailures = 0;
    try {
      for (let i = 0; i < 300; i++) {
        try {
          const res = await fetch('/api/social/comments/bulk-like', { method: 'POST' });
          if (!res.ok) throw new Error('batch failed');
          const data = await res.json();
          consecutiveFailures = 0;
          // Facebook comments are liked; Instagram can't be liked via the API
          // so they're just closed. Both count as handled.
          total += (data.liked || 0) + (data.closed || 0);
          setBulkProgress(`${total} handled, ${data.remaining} to go...`);
          if (!data.remaining) break;
        } catch {
          // One dropped request must not kill the sweep - back off and retry
          consecutiveFailures++;
          if (consecutiveFailures >= 3) {
            setBulkProgress(
              `Paused after ${total} (connection hiccups) - click again to continue.`
            );
            return;
          }
          setBulkProgress(`${total} liked, retrying...`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      setBulkProgress(`Done - ${total} tag/praise comments handled (Facebook liked, Instagram closed).`);
    } finally {
      setBulkLiking(false);
      queryClientRef.invalidateQueries({ queryKey: ['social-comments'] });
      queryClientRef.invalidateQueries({ queryKey: ['social-comment-counts'] });
    }
  };

  // Fresh comments load when the tool is opened; background polling is only a
  // slow safety net (Meta rate-limit care). Throttled: skipped when a sync ran
  // in the last 10 minutes, and fired at most once per page visit.
  const autoSyncFired = useRef(false);
  useEffect(() => {
    const accounts: { lastSyncAt?: string | null }[] = syncData?.accounts || [];
    if (autoSyncFired.current || accounts.length === 0) return;
    const newest = Math.max(
      0,
      ...accounts.map((a) => (a.lastSyncAt ? new Date(a.lastSyncAt).getTime() : 0))
    );
    if (Date.now() - newest < 10 * 60 * 1000) return;
    autoSyncFired.current = true;
    handleSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncData]);

  // Not connected state
  if (!authLoading && !authData?.connected) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-center max-w-md px-4">
          <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-8 h-8 text-blue-600" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            Connect Your Social Accounts
          </h2>
          <p className="text-gray-600 mb-6">
            Connect your Facebook Pages and Instagram Business accounts to start
            managing comments from one place.
          </p>
          <Link href="/admin/social">
            <Button>
              <Settings className="w-4 h-4 mr-2" />
              Connect Meta Account
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Social</h1>
            <div className="flex gap-1 mt-2">
              <button
                onClick={() => setView('comments')}
                className={cn(
                  'px-3 py-1 text-sm rounded-full border',
                  view === 'comments'
                    ? 'bg-blue-100 border-blue-300 text-blue-700 font-medium'
                    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                )}
              >
                Comments
                {tabCounts?.open ? (
                  <span className="ml-1.5 text-xs opacity-70">{tabCounts.open}</span>
                ) : null}
              </button>
              <button
                onClick={() => setView('messages')}
                className={cn(
                  'px-3 py-1 text-sm rounded-full border flex items-center gap-1',
                  view === 'messages'
                    ? 'bg-blue-100 border-blue-300 text-blue-700 font-medium'
                    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                )}
              >
                <MessageSquare className="w-3.5 h-3.5" />
                Messages
                {dmCounts?.open ? (
                  <span className="ml-1 text-xs opacity-70">{dmCounts.open}</span>
                ) : null}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Stats badges */}
            {syncData?.stats && (
              <div className="flex items-center gap-2 text-sm">
                <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded-full">
                  {syncData.stats.new} new
                </span>
                <span className="px-2 py-1 bg-yellow-100 text-yellow-700 rounded-full">
                  {syncData.stats.inProgress} in progress
                </span>
              </div>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSync}
              disabled={syncing}
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
              Sync
            </Button>
            <Link href="/admin/social">
              <Button variant="ghost" size="sm">
                <Settings className="w-4 h-4 mr-2" />
                Settings
              </Button>
            </Link>
          </div>
        </div>

        {/* Filters (comments view only) */}
        {view === 'comments' && (
          <SocialFilters
            filters={filters}
            onChange={setFilters}
            accounts={authData?.accounts || []}
          />
        )}
      </div>

      {/* Content */}
      {view === 'messages' ? (
        <ConversationsView />
      ) : (
      <div className="flex-1 flex min-h-0">
        {/* Comments List */}
        <div className="w-96 border-r bg-white flex flex-col">
          <div className="flex border-b">
            {(
              [
                ['open', 'Open'],
                ['done', 'Done'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setListTab(key)}
                className={cn(
                  'flex-1 py-2 text-sm font-medium border-b-2 transition-colors',
                  listTab === key
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-800'
                )}
              >
                {label}
                {tabCounts && (
                  <span className="ml-1.5 text-xs text-gray-400">
                    {key === 'open' ? tabCounts.open : tabCounts.done}
                  </span>
                )}
              </button>
            ))}
          </div>
          {listTab === 'open' && (
            <div className="px-4 py-1.5 border-b flex items-center justify-between gap-2">
              <span className="text-xs text-gray-500">
                Sorted: issues first, friend-tags last
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={handleBulkLikeTags}
                disabled={bulkLiking}
              >
                {bulkLiking ? 'Liking...' : '👍 Like & close tag + praise comments'}
              </Button>
            </div>
          )}
          {bulkProgress && listTab === 'open' && (
            <div className="px-4 py-1 text-xs text-gray-500 border-b bg-gray-50">{bulkProgress}</div>
          )}
          {listTab === 'open' && tabCounts?.open === 0 && (
            <div className="px-4 py-2 text-xs text-gray-500 bg-emerald-50 border-b border-emerald-100">
              All comments handled - liked, replied, or older than 14 days. New
              ones appear here; everything else is under Done.
            </div>
          )}
          <SocialCommentList
            filters={{
              ...filters,
              status: listTab === 'open' ? ['NEW', 'IN_PROGRESS', 'ESCALATED'] : ['DONE'],
            }}
            selectedId={selectedCommentId}
            onSelect={setSelectedCommentId}
          />
        </div>

        {/* Comment Detail */}
        <div className="flex-1 bg-white">
          {selectedCommentId ? (
            <SocialCommentDetail
              commentId={selectedCommentId}
              onClose={() => setSelectedCommentId(null)}
              onResolved={handleCommentResolved}
              onActionFailed={(id) => setSelectedCommentId(id)}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-gray-500">
              <div className="text-center">
                <MessageCircle className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <p>Select a comment to view details</p>
              </div>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

// Import icon for empty state
import { MessageCircle } from 'lucide-react';
