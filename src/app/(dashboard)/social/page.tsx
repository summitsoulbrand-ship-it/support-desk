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

  // Bulk-like the friend-tag comments: loops the batch endpoint until none
  // remain; a like acknowledges the tag and closes the comment.
  const [bulkLiking, setBulkLiking] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const queryClientRef = useQueryClient();
  const handleBulkLikeTags = async () => {
    if (bulkLiking) return;
    if (!window.confirm('Like and close ALL open friend-tag comments? The customers get a like from the page; nothing is posted.')) return;
    setBulkLiking(true);
    setBulkProgress('Starting...');
    let total = 0;
    try {
      for (let i = 0; i < 60; i++) {
        const res = await fetch('/api/social/comments/bulk-like', { method: 'POST' });
        if (!res.ok) break;
        const data = await res.json();
        total += data.liked || 0;
        setBulkProgress(`${total} liked, ${data.remaining} to go...`);
        if (!data.remaining) break;
      }
      setBulkProgress(`Done - ${total} tag comments liked and closed.`);
    } catch {
      setBulkProgress(`Stopped after ${total} - try again to continue.`);
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
              <button
                onClick={handleBulkLikeTags}
                disabled={bulkLiking}
                className="text-xs text-blue-600 hover:underline disabled:text-gray-400"
              >
                {bulkLiking ? 'Liking...' : 'Like & close all tag comments'}
              </button>
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
