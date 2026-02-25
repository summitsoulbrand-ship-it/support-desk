'use client';

/**
 * Settings page - user profile and app preferences
 */

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Save, User, Settings, GitMerge, Loader2, Database, Download, Upload, Trash2, RefreshCw } from 'lucide-react';

interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: string;
  signature: string | null;
}

interface AppSettings {
  id: string;
  autoMergeThreads: boolean;
  autoMergeWindowHours: number;
}

interface Backup {
  filename: string;
  size: number;
  sizeFormatted: string;
  createdAt: string;
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [signature, setSignature] = useState('');

  // App settings state
  const [autoMergeThreads, setAutoMergeThreads] = useState(false);
  const [autoMergeWindowHours, setAutoMergeWindowHours] = useState(24);

  const { data: profile, isLoading } = useQuery<UserProfile>({
    queryKey: ['profile'],
    queryFn: async () => {
      const res = await fetch('/api/profile');
      if (!res.ok) throw new Error('Failed to fetch profile');
      return res.json();
    },
    staleTime: 60000, // Cache for 1 minute
  });

  const { data: appSettings, isLoading: settingsLoading } = useQuery<AppSettings>({
    queryKey: ['app-settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error('Failed to fetch settings');
      return res.json();
    },
    enabled: profile?.role === 'ADMIN',
    staleTime: 60000, // Cache for 1 minute
  });

  // Update form when profile loads
  useEffect(() => {
    if (profile) {
      setName(profile.name);
      setSignature(profile.signature || '');
    }
  }, [profile]);

  // Update app settings form when loaded
  useEffect(() => {
    if (appSettings) {
      setAutoMergeThreads(appSettings.autoMergeThreads);
      setAutoMergeWindowHours(appSettings.autoMergeWindowHours);
    }
  }, [appSettings]);

  const saveProfileMutation = useMutation({
    mutationFn: async (data: { name: string; signature: string }) => {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
  });

  const saveSettingsMutation = useMutation({
    mutationFn: async (data: { autoMergeThreads: boolean; autoMergeWindowHours: number }) => {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['app-settings'] });
    },
  });

  // Backup queries and mutations
  const { data: backupsData, isLoading: backupsLoading, error: backupsError, refetch: refetchBackups } = useQuery<{ backups: Backup[] }>({
    queryKey: ['backups'],
    queryFn: async () => {
      const res = await fetch('/api/admin/backup');
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || err.details || 'Failed to fetch backups');
      }
      return res.json();
    },
    enabled: profile?.role === 'ADMIN',
    staleTime: 30000,
    retry: false,
  });

  const createBackupMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/admin/backup', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create backup');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups'] });
    },
  });

  const restoreBackupMutation = useMutation({
    mutationFn: async (filename: string) => {
      const res = await fetch('/api/admin/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to restore backup');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups'] });
      // Reload the page to reflect restored data
      window.location.reload();
    },
  });

  const deleteBackupMutation = useMutation({
    mutationFn: async (filename: string) => {
      const res = await fetch(`/api/admin/backup?filename=${encodeURIComponent(filename)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete backup');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups'] });
    },
  });

  const [restoreConfirm, setRestoreConfirm] = useState<string | null>(null);

  const handleSaveProfile = () => {
    saveProfileMutation.mutate({ name, signature });
  };

  const handleSaveSettings = () => {
    saveSettingsMutation.mutate({ autoMergeThreads, autoMergeWindowHours });
  };

  if (isLoading) {
    return (
      <div className="p-6 max-w-2xl">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-6" />
          <div className="space-y-4">
            <div className="h-10 bg-gray-200 rounded" />
            <div className="h-32 bg-gray-200 rounded" />
          </div>
        </div>
      </div>
    );
  }

  const isAdmin = profile?.role === 'ADMIN';

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>

      {/* Profile Settings */}
      <div className="bg-white rounded-lg border p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
            <User className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h2 className="font-semibold text-gray-900">Profile Settings</h2>
            <p className="text-sm text-gray-700">
              Manage your account settings and email signature
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Display Name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <Input value={profile?.email || ''} disabled className="bg-gray-50" />
            <p className="text-xs text-gray-600 mt-1">
              Contact an administrator to change your email
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email Signature
            </label>
            <textarea
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              rows={5}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none bg-white text-gray-900 placeholder:text-gray-600"
              placeholder="Best regards,&#10;Your Name&#10;Support Team&#10;https://example.com"
            />
            <p className="text-xs text-gray-600 mt-1">
              Supports plain text and links (URLs will be clickable). This signature will be included in AI-suggested replies.
            </p>
            {signature && (
              <div className="mt-3 p-3 bg-gray-50 rounded-lg border">
                <p className="text-xs font-medium text-gray-500 mb-2">Preview:</p>
                <div className="text-sm text-gray-900 whitespace-pre-wrap">
                  {signature.split('\n').map((line, i) => (
                    <p key={i}>
                      {line.split(/(https?:\/\/[^\s]+)/g).map((part, j) =>
                        part.match(/^https?:\/\//) ? (
                          <a
                            key={j}
                            href={part}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline"
                          >
                            {part}
                          </a>
                        ) : (
                          part
                        )
                      )}
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 mt-6 pt-4 border-t">
          <Button
            onClick={handleSaveProfile}
            loading={saveProfileMutation.isPending}
            disabled={saveProfileMutation.isPending}
          >
            <Save className="w-4 h-4 mr-2" />
            Save Profile
          </Button>

          {saveProfileMutation.error && (
            <span className="text-sm text-red-500">
              {saveProfileMutation.error.message}
            </span>
          )}

          {saveProfileMutation.isSuccess && (
            <span className="text-sm text-green-500">Profile saved</span>
          )}
        </div>
      </div>

      {/* App Settings (Admin only) */}
      {isAdmin && (
        <div className="bg-white rounded-lg border p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-lg bg-purple-100 flex items-center justify-center">
              <Settings className="w-5 h-5 text-purple-600" />
            </div>
            <div>
              <h2 className="font-semibold text-gray-900">App Settings</h2>
              <p className="text-sm text-gray-700">
                Configure global application behavior
              </p>
            </div>
          </div>

          {settingsLoading ? (
            <div className="animate-pulse space-y-4">
              <div className="h-10 bg-gray-200 rounded" />
              <div className="h-10 bg-gray-200 rounded" />
            </div>
          ) : (
            <div className="space-y-4">
              {/* Auto-merge threads */}
              <div className="flex items-start gap-4 p-4 rounded-lg border bg-gray-50">
                <div className="w-10 h-10 rounded-lg bg-green-100 flex items-center justify-center flex-shrink-0">
                  <GitMerge className="w-5 h-5 text-green-600" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-medium text-gray-900">Auto-merge Threads</h3>
                      <p className="text-sm text-gray-600">
                        Automatically merge new emails from the same customer into existing open threads
                      </p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoMergeThreads}
                        onChange={(e) => setAutoMergeThreads(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                    </label>
                  </div>
                  {autoMergeThreads && (
                    <div className="mt-4 flex items-center gap-3">
                      <label className="text-sm text-gray-600">Merge window:</label>
                      <Input
                        type="number"
                        value={autoMergeWindowHours}
                        onChange={(e) => setAutoMergeWindowHours(parseInt(e.target.value) || 24)}
                        min={1}
                        max={168}
                        className="w-20"
                      />
                      <span className="text-sm text-gray-600">hours</span>
                      <p className="text-xs text-gray-500 ml-2">
                        (Only merge into threads with activity within this window)
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center gap-3 mt-6 pt-4 border-t">
            <Button
              onClick={handleSaveSettings}
              loading={saveSettingsMutation.isPending}
              disabled={saveSettingsMutation.isPending || settingsLoading}
            >
              <Save className="w-4 h-4 mr-2" />
              Save App Settings
            </Button>

            {saveSettingsMutation.error && (
              <span className="text-sm text-red-500">
                {saveSettingsMutation.error.message}
              </span>
            )}

            {saveSettingsMutation.isSuccess && (
              <span className="text-sm text-green-500">App settings saved</span>
            )}
          </div>
        </div>
      )}

      {/* Database Backup (Admin only) */}
      {isAdmin && (
        <div className="bg-white rounded-lg border p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-lg bg-orange-100 flex items-center justify-center">
              <Database className="w-5 h-5 text-orange-600" />
            </div>
            <div>
              <h2 className="font-semibold text-gray-900">Database Backup</h2>
              <p className="text-sm text-gray-700">
                Create and restore database backups
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Button
                onClick={() => createBackupMutation.mutate()}
                loading={createBackupMutation.isPending}
                disabled={createBackupMutation.isPending}
              >
                <Download className="w-4 h-4 mr-2" />
                Create Backup Now
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => refetchBackups()}
                disabled={backupsLoading}
              >
                <RefreshCw className={`w-4 h-4 ${backupsLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>

            {createBackupMutation.error && (
              <div className="text-sm text-red-500">
                {createBackupMutation.error.message}
              </div>
            )}

            {createBackupMutation.isSuccess && (
              <div className="text-sm text-green-500">
                Backup created successfully
              </div>
            )}

            {restoreBackupMutation.error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                Restore failed: {restoreBackupMutation.error.message}
              </div>
            )}

            <div className="border rounded-lg overflow-hidden">
              <div className="bg-gray-50 px-4 py-2 border-b">
                <p className="text-sm font-medium text-gray-700">Available Backups</p>
              </div>
              {backupsLoading ? (
                <div className="p-4 flex items-center justify-center">
                  <Loader2 className="w-5 h-5 text-gray-400 animate-spin" />
                </div>
              ) : backupsError ? (
                <div className="p-4 text-sm text-red-500 text-center">
                  Error loading backups: {backupsError.message}
                </div>
              ) : !backupsData?.backups?.length ? (
                <div className="p-4 text-sm text-gray-500 text-center">
                  No backups found. Create one to protect your data.
                </div>
              ) : (
                <div className="divide-y">
                  {backupsData.backups.map((backup) => (
                    <div key={backup.filename} className="px-4 py-3 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{backup.filename}</p>
                        <p className="text-xs text-gray-500">
                          {backup.sizeFormatted} • {new Date(backup.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {restoreConfirm === backup.filename ? (
                          <>
                            <span className="text-xs text-amber-600 mr-2">Restore this backup?</span>
                            <Button
                              size="xs"
                              variant="danger"
                              onClick={() => {
                                restoreBackupMutation.mutate(backup.filename);
                                setRestoreConfirm(null);
                              }}
                              loading={restoreBackupMutation.isPending}
                            >
                              Yes, Restore
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => setRestoreConfirm(null)}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="xs"
                              variant="secondary"
                              onClick={() => setRestoreConfirm(backup.filename)}
                              disabled={restoreBackupMutation.isPending}
                            >
                              <Upload className="w-3 h-3 mr-1" />
                              Restore
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => deleteBackupMutation.mutate(backup.filename)}
                              disabled={deleteBackupMutation.isPending}
                            >
                              <Trash2 className="w-3 h-3 text-gray-500" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-xs text-amber-800">
                <strong>Important:</strong> Restoring a backup will replace all current data.
                A pre-restore backup is automatically created before each restore operation.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
