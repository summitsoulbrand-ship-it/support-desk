'use client';

/**
 * Inbox list component - displays list of threads
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { cn, formatDate, truncate } from '@/lib/utils';
import { useAutoSync } from '@/hooks/use-auto-sync';
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
  assignedUser: {
    id: string;
    name: string;
    email: string;
  } | null;
  messages: {
    id: string;
    direction: string;
    bodyText: string | null;
    sentAt: string;
  }[];
  tags?: Tag[];
}

interface InboxListProps {
  selectedThreadId?: string;
  onSelectThread: (threadId: string) => void;
}

type FilterType = 'all' | 'closed' | 'trash' | 'design';

export function InboxList({ selectedThreadId, onSelectThread }: InboxListProps) {
  const [filter, setFilter] = useState<FilterType>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const queryClient = useQueryClient();

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

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['threads', filter, searchQuery],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filter === 'closed') params.set('status', 'CLOSED');
      else if (filter === 'trash') params.set('status', 'TRASHED');
      else if (filter === 'design') params.set('tag', 'Design');
      // Default 'all' shows only OPEN and PENDING (not CLOSED)

      if (searchQuery) params.set('search', searchQuery);

      const res = await fetch(`/api/threads?${params}`);
      if (!res.ok) throw new Error('Failed to fetch threads');
      return res.json();
    },
    staleTime: 10000, // Consider data fresh for 10 seconds
    refetchInterval: 30000, // Auto-refresh every 30 seconds
    refetchOnWindowFocus: true,
  });

  // Cache the default threads list for quick access
  useEffect(() => {
    if (data && filter === 'all' && searchQuery.trim() === '') {
      queryClient.setQueryData(['threads-open'], data);
    }
  }, [data, filter, searchQuery, queryClient]);

  const threads: Thread[] = (data as { threads?: Thread[] })?.threads || [];

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
    { key: 'trash', label: 'Trash', icon: <Trash2 className="w-4 h-4" /> },
  ];

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
          <h2 className="text-lg font-semibold text-gray-900">Inbox</h2>
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
      </div>

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-32">
            <RefreshCw className="w-6 h-6 text-gray-400 animate-spin" />
          </div>
        ) : threads.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-gray-500">
            <Inbox className="w-8 h-8 mb-2" />
            <p className="text-sm">No threads found</p>
          </div>
        ) : (
          <ul className="divide-y">
            {threads.map((thread) => (
              <li key={thread.id}>
                <button
                  onClick={() => onSelectThread(thread.id)}
                  className={cn(
                    'w-full text-left p-4 hover:bg-gray-50 transition-colors',
                    selectedThreadId === thread.id && 'bg-blue-50'
                  )}
                >
                  <div className="flex items-start gap-3">
                    <Avatar
                      name={thread.customerName || thread.customerEmail}
                      size="sm"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-gray-900 truncate">
                          {thread.customerName || thread.customerEmail}
                          {thread.messages.length > 1 && (
                            <span className="ml-1 text-gray-500 font-normal">
                              ({thread.messages.length})
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
                        {thread.messages[0]?.bodyText
                          ? truncate(thread.messages[0].bodyText, 60)
                          : 'No preview available'}
                      </p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {getStatusBadge(thread.status)}
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
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
