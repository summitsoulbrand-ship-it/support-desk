'use client';

/**
 * Trash page - manage trashed threads
 */

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn, formatDate, truncate } from '@/lib/utils';
import {
  RefreshCw,
  Trash2,
  RotateCcw,
  AlertCircle,
  Inbox,
} from 'lucide-react';

interface Thread {
  id: string;
  subject: string;
  customerEmail: string;
  customerName: string | null;
  status: 'TRASHED';
  lastMessageAt: string;
  messages: {
    id: string;
    direction: string;
    bodyText: string | null;
    sentAt: string;
  }[];
}

export default function TrashPage() {
  const queryClient = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['trash-threads'],
    queryFn: async () => {
      const res = await fetch('/api/threads?status=TRASHED');
      if (!res.ok) throw new Error('Failed to fetch trash');
      return res.json();
    },
  });

  const threads: Thread[] = data?.threads || [];

  const selectedCount = selectedIds.size;
  const allSelected = threads.length > 0 && selectedCount === threads.length;

  const restoreMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const res = await fetch('/api/threads/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore', ids }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to restore threads');
      }
      return data;
    },
    onSuccess: () => {
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ['trash-threads'] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
    },
  });

  const purgeMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const res = await fetch('/api/threads/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'purge', ids }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to delete threads');
      }
      return data;
    },
    onSuccess: () => {
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ['trash-threads'] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
    },
  });

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds(new Set(threads.map((t) => t.id)));
  };

  const toggleOne = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const selectedIdsArray = useMemo(() => Array.from(selectedIds), [selectedIds]);

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Trash</h1>
          <p className="text-sm text-gray-600">
            Trashed threads can be restored or permanently deleted.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={cn('w-4 h-4 mr-2', isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      <div className="bg-white rounded-lg border">
        <div className="flex items-center justify-between p-4 border-b bg-gray-50">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="h-4 w-4"
            />
            <span className="text-sm text-gray-700">
              {selectedCount} selected
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => restoreMutation.mutate(selectedIdsArray)}
              disabled={selectedCount === 0 || restoreMutation.isPending}
              loading={restoreMutation.isPending}
            >
              <RotateCcw className="w-4 h-4 mr-1" />
              Restore
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (selectedCount === 0 || purgeMutation.isPending) return;
                const confirmed = window.confirm(
                  `Permanently delete ${selectedCount} thread(s)? This cannot be undone.`
                );
                if (confirmed) {
                  purgeMutation.mutate(selectedIdsArray);
                }
              }}
              disabled={selectedCount === 0 || purgeMutation.isPending}
              loading={purgeMutation.isPending}
            >
              <Trash2 className="w-4 h-4 mr-1" />
              Delete Permanently
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : threads.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <Inbox className="w-10 h-10 mx-auto mb-2 text-gray-300" />
            No trashed threads
          </div>
        ) : (
          <ul className="divide-y">
            {threads.map((thread) => (
              <li key={thread.id} className="p-4">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(thread.id)}
                    onChange={() => toggleOne(thread.id)}
                    className="h-4 w-4 mt-1"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-gray-900 truncate">
                        {thread.customerName || thread.customerEmail}
                      </span>
                      <span className="text-xs text-gray-500 whitespace-nowrap">
                        {formatDate(thread.lastMessageAt)}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-gray-800 truncate">
                      {thread.subject}
                    </p>
                    <p className="text-sm text-gray-600 truncate">
                      {thread.messages[0]?.bodyText
                        ? truncate(thread.messages[0].bodyText, 80)
                        : 'No preview available'}
                    </p>
                    <div className="flex items-center gap-2 mt-2">
                      <Badge variant="default">Trash</Badge>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {(restoreMutation.error || purgeMutation.error) && (
        <div className="mt-4 flex items-center gap-2 text-sm text-red-600">
          <AlertCircle className="w-4 h-4" />
          {restoreMutation.error?.message || purgeMutation.error?.message}
        </div>
      )}
    </div>
  );
}
