'use client';

/**
 * Social Comments Page
 * Main view for managing Facebook and Instagram comments
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SocialCommentList } from '@/components/social/comment-list';
import { SocialCommentDetail } from '@/components/social/comment-detail';
import { SocialFilters, type SocialFilterState } from '@/components/social/filters';
import { Button } from '@/components/ui/button';
import { RefreshCw, Settings, AlertCircle } from 'lucide-react';
import Link from 'next/link';

export default function SocialPage() {
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
    <div className="flex-1 flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Social Comments</h1>
            <p className="text-sm text-gray-500">
              Manage comments from Facebook and Instagram
            </p>
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

        {/* Filters */}
        <SocialFilters
          filters={filters}
          onChange={setFilters}
          accounts={authData?.accounts || []}
        />
      </div>

      {/* Content */}
      <div className="flex-1 flex min-h-0">
        {/* Comments List */}
        <div className="w-96 border-r bg-white flex flex-col">
          <SocialCommentList
            filters={filters}
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
    </div>
  );
}

// Import icon for empty state
import { MessageCircle } from 'lucide-react';
