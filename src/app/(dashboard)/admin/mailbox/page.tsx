'use client';

/**
 * Admin Mailbox page - email sync management
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn, formatDateFull } from '@/lib/utils';
import {
  Mail,
  RefreshCw,
  Check,
  X,
  AlertCircle,
  Clock,
  Inbox,
} from 'lucide-react';

interface Mailbox {
  id: string;
  displayName: string;
  emailAddress: string;
  lastSyncAt: string | null;
  syncError: string | null;
  active: boolean;
}

interface SyncJob {
  id: string;
  mailboxId: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  startedAt: string | null;
  completedAt: string | null;
  messagesProcessed: number;
  errorMessage: string | null;
  createdAt: string;
}

interface SyncStatus {
  mailboxes: Mailbox[];
  jobs: SyncJob[];
}

export default function MailboxPage() {
  const queryClient = useQueryClient();

  const { data, isLoading, refetch, isFetching } = useQuery<SyncStatus>({
    queryKey: ['sync-status'],
    queryFn: async () => {
      const res = await fetch('/api/sync');
      if (!res.ok) throw new Error('Failed to fetch sync status');
      return res.json();
    },
    refetchInterval: 10000, // Refresh every 10 seconds
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.details || data.error || 'Sync failed');
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sync-status'] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
    },
  });

  const getStatusIcon = (status: SyncJob['status']) => {
    switch (status) {
      case 'COMPLETED':
        return <Check className="w-4 h-4 text-green-500" />;
      case 'FAILED':
        return <X className="w-4 h-4 text-red-500" />;
      case 'RUNNING':
        return <RefreshCw className="w-4 h-4 text-blue-500 animate-spin" />;
      default:
        return <Clock className="w-4 h-4 text-gray-400" />;
    }
  };

  const getStatusBadge = (status: SyncJob['status']) => {
    const variants: Record<SyncJob['status'], 'success' | 'error' | 'warning' | 'default'> = {
      COMPLETED: 'success',
      FAILED: 'error',
      RUNNING: 'info' as never,
      PENDING: 'default',
    };
    return <Badge variant={variants[status] || 'default'}>{status}</Badge>;
  };

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Email Sync</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw
              className={cn('w-4 h-4 mr-2', isFetching && 'animate-spin')}
            />
            Refresh
          </Button>
          <Button
            onClick={() => syncMutation.mutate()}
            loading={syncMutation.isPending}
          >
            <Mail className="w-4 h-4 mr-2" />
            Sync Now
          </Button>
        </div>
      </div>

      {/* Mailboxes */}
      <div className="bg-white rounded-lg border mb-6">
        <div className="p-4 border-b bg-gray-50">
          <h2 className="font-semibold text-gray-900">Mailboxes</h2>
        </div>
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : data?.mailboxes.length === 0 ? (
          <div className="p-8 text-center">
            <Inbox className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500">No mailboxes configured</p>
            <p className="text-sm text-gray-400 mt-1">
              Configure email integration to create a mailbox
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {data?.mailboxes.map((mailbox) => (
              <div
                key={mailbox.id}
                className="p-4 flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                    <Mail className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">
                      {mailbox.displayName}
                    </p>
                    <p className="text-sm text-gray-500">{mailbox.emailAddress}</p>
                  </div>
                </div>
                <div className="text-right">
                  {mailbox.syncError ? (
                    <div className="flex items-center gap-2 text-red-500">
                      <AlertCircle className="w-4 h-4" />
                      <span className="text-sm">{mailbox.syncError}</span>
                    </div>
                  ) : mailbox.lastSyncAt ? (
                    <div>
                      <p className="text-sm text-gray-500">Last sync</p>
                      <p className="text-sm font-medium">
                        {formatDateFull(mailbox.lastSyncAt)}
                      </p>
                    </div>
                  ) : (
                    <span className="text-sm text-gray-500">Never synced</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sync mutation result */}
      {syncMutation.data && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
          <div className="flex items-center gap-2 text-green-700">
            <Check className="w-5 h-5" />
            <span className="font-medium">Sync completed</span>
          </div>
          <p className="text-sm text-green-600 mt-1">
            Processed {syncMutation.data.messagesProcessed} new messages
          </p>
        </div>
      )}

      {syncMutation.error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <div className="flex items-center gap-2 text-red-700">
            <AlertCircle className="w-5 h-5" />
            <span className="font-medium">Sync failed</span>
          </div>
          <p className="text-sm text-red-600 mt-1">
            {syncMutation.error.message}
          </p>
        </div>
      )}

      {/* Recent sync jobs */}
      <div className="bg-white rounded-lg border">
        <div className="p-4 border-b bg-gray-50">
          <h2 className="font-semibold text-gray-900">Recent Sync Jobs</h2>
        </div>
        {data?.jobs.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No sync jobs yet
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">
                  Status
                </th>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">
                  Started
                </th>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">
                  Completed
                </th>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">
                  Messages
                </th>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">
                  Error
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {(data?.jobs || []).slice(0, 5).map((job) => (
                <tr key={job.id}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {getStatusIcon(job.status)}
                      {getStatusBadge(job.status)}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {job.startedAt ? formatDateFull(job.startedAt) : '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {job.completedAt ? formatDateFull(job.completedAt) : '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">
                    {job.messagesProcessed}
                  </td>
                  <td className="px-4 py-3 text-sm text-red-500">
                    {job.errorMessage || '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
