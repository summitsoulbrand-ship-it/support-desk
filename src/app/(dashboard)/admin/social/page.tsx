'use client';

/**
 * Admin Social Settings Page
 * Connect Meta accounts and manage automation rules
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  Facebook,
  Instagram,
  Plus,
  Trash2,
  Settings,
  Zap,
  AlertCircle,
  CheckCircle,
  Loader2,
  ExternalLink,
  RefreshCw,
  ChevronRight,
  Power,
  PowerOff,
  Edit,
  Copy,
  X,
} from 'lucide-react';

export default function AdminSocialPage() {
  const queryClient = useQueryClient();
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [editingRule, setEditingRule] = useState<any>(null);
  const [connectStep, setConnectStep] = useState<'idle' | 'selecting' | 'saving'>('idle');
  const [selectedPages, setSelectedPages] = useState<string[]>([]);
  const [availablePages, setAvailablePages] = useState<any[]>([]);
  const [tempToken, setTempToken] = useState<string>('');

  // Fetch connection status
  const { data: authData, isLoading: authLoading } = useQuery({
    queryKey: ['social-auth'],
    queryFn: async () => {
      const res = await fetch('/api/social/auth');
      if (!res.ok) throw new Error('Failed to fetch auth status');
      return res.json();
    },
  });

  // Fetch accounts
  const { data: accountsData } = useQuery({
    queryKey: ['social-accounts'],
    queryFn: async () => {
      const res = await fetch('/api/social/accounts');
      if (!res.ok) throw new Error('Failed to fetch accounts');
      return res.json();
    },
    enabled: authData?.connected,
  });

  // Fetch rules
  const { data: rulesData } = useQuery({
    queryKey: ['social-rules'],
    queryFn: async () => {
      const res = await fetch('/api/social/rules');
      if (!res.ok) throw new Error('Failed to fetch rules');
      return res.json();
    },
  });

  // Disconnect mutation
  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/social/auth', { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to disconnect');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['social-auth'] });
      queryClient.invalidateQueries({ queryKey: ['social-accounts'] });
    },
  });

  // Sync mutation
  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/social/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Sync failed');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['social-accounts'] });
    },
  });

  // Toggle account enabled
  const toggleAccountMutation = useMutation({
    mutationFn: async ({ accountId, enabled }: { accountId: string; enabled: boolean }) => {
      const res = await fetch('/api/social/accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, enabled }),
      });
      if (!res.ok) throw new Error('Failed to update account');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['social-accounts'] });
    },
  });

  // Delete rule mutation
  const deleteRuleMutation = useMutation({
    mutationFn: async (ruleId: string) => {
      const res = await fetch(`/api/social/rules/${ruleId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete rule');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['social-rules'] });
    },
  });

  // Toggle rule enabled
  const toggleRuleMutation = useMutation({
    mutationFn: async ({ ruleId, enabled }: { ruleId: string; enabled: boolean }) => {
      const res = await fetch(`/api/social/rules/${ruleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error('Failed to update rule');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['social-rules'] });
    },
  });

  const [connectError, setConnectError] = useState<string | null>(null);

  const handleConnect = async () => {
    setConnectError(null);
    try {
      const res = await fetch('/api/social/auth?action=auth_url');
      const data = await res.json();

      if (data.error) {
        setConnectError(data.error);
        return;
      }

      if (data.authUrl) {
        // Open OAuth in popup
        const popup = window.open(data.authUrl, 'meta-oauth', 'width=600,height=700');

        if (!popup) {
          setConnectError('Popup blocked. Please allow popups for this site and try again.');
          return;
        }

        // Listen for OAuth callback
        const handleMessage = async (event: MessageEvent) => {
          console.log('[OAuth] Received message:', event.data?.type);
          if (event.origin !== window.location.origin) return;
          if (event.data.type === 'meta-oauth-callback') {
            console.log('[OAuth] Got callback code, exchanging for token...');
            popup?.close();
            window.removeEventListener('message', handleMessage);

            // Exchange code for token and get pages
            const tokenRes = await fetch('/api/social/auth', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: event.data.code }),
            });
            const tokenData = await tokenRes.json();
            console.log('[OAuth] Token response:', { success: tokenData.success, pagesCount: tokenData.pages?.length, error: tokenData.error });

            if (tokenData.error) {
              setConnectError(tokenData.error);
              return;
            }

            if (tokenData.pages && tokenData.pages.length > 0) {
              console.log('[OAuth] Setting pages for selection:', tokenData.pages.map((p: any) => p.name));
              setAvailablePages(tokenData.pages);
              setTempToken(tokenData.tempToken);
              setConnectStep('selecting');
              console.log('[OAuth] connectStep set to selecting');
            } else if (tokenData.success === false) {
              // No pages found
              setConnectError(tokenData.error || 'No Facebook Pages found.');
            }
          }
        };

        window.addEventListener('message', handleMessage);

        // Cleanup listener after 5 minutes
        setTimeout(() => {
          window.removeEventListener('message', handleMessage);
        }, 300000);
      }
    } catch (err) {
      console.error('Connect error:', err);
      setConnectError('Failed to start connection. Please try again.');
    }
  };

  const handleSavePages = async () => {
    if (selectedPages.length === 0) return;

    setConnectStep('saving');

    const res = await fetch('/api/social/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selectedPageIds: selectedPages,
        tempToken,
      }),
    });

    if (res.ok) {
      queryClient.invalidateQueries({ queryKey: ['social-auth'] });
      queryClient.invalidateQueries({ queryKey: ['social-accounts'] });
      setConnectStep('idle');
      setSelectedPages([]);
      setAvailablePages([]);
      setTempToken('');
    }
  };

  const accounts = accountsData?.accounts || [];
  const rules = rulesData?.rules || [];

  return (
    <div className="max-w-4xl mx-auto p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Social Comments Settings</h1>
        <p className="text-gray-600 mt-1">
          Connect your Facebook Pages and Instagram accounts to manage comments
        </p>
      </div>

      {/* Connection Status */}
      <div className="bg-white rounded-lg border p-6 mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Settings className="w-5 h-5" />
            Meta Connection
          </h2>
          {authData?.connected && (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
              >
                <RefreshCw className={cn("w-4 h-4 mr-1", syncMutation.isPending && "animate-spin")} />
                {syncMutation.isPending ? 'Syncing...' : 'Sync Now'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                onClick={() => {
                  if (confirm('Disconnect Meta? This will stop comment syncing.')) {
                    disconnectMutation.mutate();
                  }
                }}
              >
                Disconnect
              </Button>
            </div>
          )}
        </div>

        {authLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : connectStep === 'selecting' || connectStep === 'saving' ? (
          <div className="space-y-4">
            <p className="text-gray-600">Select the pages you want to connect:</p>
            <div className="space-y-2">
              {availablePages.map((page) => (
                <label
                  key={page.id}
                  className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100"
                >
                  <input
                    type="checkbox"
                    checked={selectedPages.includes(page.id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedPages([...selectedPages, page.id]);
                      } else {
                        setSelectedPages(selectedPages.filter((id) => id !== page.id));
                      }
                    }}
                    className="rounded border-gray-300"
                  />
                  <div className="flex items-center gap-3 flex-1">
                    {page.pictureUrl && (
                      <img
                        src={page.pictureUrl}
                        alt={page.name}
                        className="w-10 h-10 rounded-full"
                      />
                    )}
                    <div>
                      <p className="font-medium">{page.name}</p>
                      <div className="flex items-center gap-2 text-sm text-gray-500">
                        <Facebook className="w-3 h-3" />
                        <span>Facebook Page</span>
                        {page.hasInstagram && (
                          <>
                            <span>•</span>
                            <Instagram className="w-3 h-3" />
                            <span>@{page.instagramAccount?.username}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <Button onClick={handleSavePages} disabled={selectedPages.length === 0 || connectStep === 'saving'}>
                {connectStep === 'saving' ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Connect Selected Pages
              </Button>
              <Button variant="ghost" onClick={() => { setConnectStep('idle'); setAvailablePages([]); setSelectedPages([]); }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : authData?.connected ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-green-600">
              <CheckCircle className="w-5 h-5" />
              <span className="font-medium">Connected to Meta</span>
            </div>

            {/* Sync status messages */}
            {syncMutation.isSuccess && (
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
                Sync completed successfully! Comments have been updated.
              </div>
            )}
            {syncMutation.error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex items-start gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>Sync failed: {(syncMutation.error as Error).message}</span>
              </div>
            )}

            {/* Connected accounts */}
            <div className="space-y-3">
              {accounts.length === 0 ? (
                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <p className="text-yellow-800 text-sm mb-3">
                    No Facebook Pages or Instagram accounts connected yet. Click below to connect your pages.
                  </p>
                  <Button onClick={handleConnect} size="sm">
                    <Facebook className="w-4 h-4 mr-2" />
                    Connect Facebook Pages
                  </Button>
                </div>
              ) : (
                <>
                  {accounts.map((account: any) => (
                    <div
                      key={account.id}
                      className="flex items-center justify-between p-4 bg-gray-50 rounded-lg"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={cn(
                            'w-10 h-10 rounded-full flex items-center justify-center',
                            account.platform === 'FACEBOOK'
                              ? 'bg-blue-600'
                              : 'bg-gradient-to-br from-purple-500 to-pink-500'
                          )}
                        >
                          {account.platform === 'FACEBOOK' ? (
                            <Facebook className="w-5 h-5 text-white" />
                          ) : (
                            <Instagram className="w-5 h-5 text-white" />
                          )}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">{account.name}</p>
                          <p className="text-sm text-gray-500">
                            {account.platform === 'FACEBOOK' ? 'Facebook Page' : 'Instagram Business'}
                            {account.username && ` • @${account.username}`}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-gray-500">
                          {account.commentCount || 0} comments
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleAccountMutation.mutate({
                            accountId: account.id,
                            enabled: !account.enabled,
                          })}
                        >
                          {account.enabled ? (
                            <Power className="w-4 h-4 text-green-600" />
                          ) : (
                            <PowerOff className="w-4 h-4 text-gray-400" />
                          )}
                        </Button>
                      </div>
                    </div>
                  ))}
                  <Button variant="ghost" size="sm" onClick={handleConnect} className="mt-2">
                    <Plus className="w-4 h-4 mr-1" />
                    Add More Pages
                  </Button>
                </>
              )}
            </div>
          </div>
        ) : (
          <div>
            <p className="text-gray-600 mb-4">
              Connect your Meta account to start managing comments from Facebook and Instagram.
            </p>
            {connectError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex items-start gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>{connectError}</span>
              </div>
            )}
            <Button onClick={handleConnect}>
              <Facebook className="w-4 h-4 mr-2" />
              Connect with Facebook
            </Button>
          </div>
        )}
      </div>

      {/* Automation Rules */}
      <div className="bg-white rounded-lg border p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Zap className="w-5 h-5" />
            Automation Rules
          </h2>
          <Button onClick={() => {
            setEditingRule(null);
            setShowRuleModal(true);
          }}>
            <Plus className="w-4 h-4 mr-2" />
            Add Rule
          </Button>
        </div>

        {rules.length === 0 ? (
          <div className="text-center py-8">
            <Zap className="w-12 h-12 mx-auto mb-3 text-gray-300" />
            <p className="text-gray-500">No automation rules configured</p>
            <p className="text-sm text-gray-400 mt-1">
              Create rules to automatically hide or label comments
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {rules.map((rule: any) => (
              <div
                key={rule.id}
                className="flex items-center justify-between p-4 bg-gray-50 rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={cn(
                      'w-10 h-10 rounded-lg flex items-center justify-center',
                      rule.enabled ? 'bg-green-100' : 'bg-gray-200'
                    )}
                  >
                    <Zap
                      className={cn(
                        'w-5 h-5',
                        rule.enabled ? 'text-green-600' : 'text-gray-400'
                      )}
                    />
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">{rule.name}</p>
                    <div className="flex items-center gap-2 text-sm text-gray-500">
                      <span>
                        {rule.platforms.map((p: string) => p === 'FACEBOOK' ? 'FB' : 'IG').join(', ')}
                      </span>
                      <span>•</span>
                      <span>{rule.matchCount} matches</span>
                      {rule.dryRun && (
                        <>
                          <span>•</span>
                          <span className="text-yellow-600">Dry Run</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleRuleMutation.mutate({
                      ruleId: rule.id,
                      enabled: !rule.enabled,
                    })}
                  >
                    {rule.enabled ? (
                      <Power className="w-4 h-4 text-green-600" />
                    ) : (
                      <PowerOff className="w-4 h-4 text-gray-400" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditingRule(rule);
                      setShowRuleModal(true);
                    }}
                  >
                    <Edit className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    onClick={() => {
                      if (confirm('Delete this rule?')) {
                        deleteRuleMutation.mutate(rule.id);
                      }
                    }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Webhook Info */}
      {authData?.connected && (
        <div className="bg-white rounded-lg border p-6 mt-8">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Webhook Setup</h2>
          <p className="text-sm text-gray-600 mb-4">
            Configure these settings in your Meta Developer App to receive real-time comment notifications:
          </p>
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <div>
                <p className="text-sm font-medium">Callback URL</p>
                <p className="text-xs text-gray-500 font-mono">
                  {typeof window !== 'undefined' ? `${window.location.origin}/api/social/webhook` : '/api/social/webhook'}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(`${window.location.origin}/api/social/webhook`);
                }}
              >
                <Copy className="w-4 h-4" />
              </Button>
            </div>
            <div className="p-3 bg-yellow-50 rounded-lg text-sm text-yellow-800">
              <p className="font-medium">Verify Token</p>
              <p>Set in your environment variables as <code className="bg-yellow-100 px-1 rounded">META_WEBHOOK_VERIFY_TOKEN</code></p>
            </div>
          </div>
        </div>
      )}

      {/* Rule Modal */}
      {showRuleModal && (
        <RuleModal
          rule={editingRule}
          accounts={accounts}
          onClose={() => {
            setShowRuleModal(false);
            setEditingRule(null);
          }}
          onSave={() => {
            queryClient.invalidateQueries({ queryKey: ['social-rules'] });
            setShowRuleModal(false);
            setEditingRule(null);
          }}
        />
      )}
    </div>
  );
}

// Rule Modal Component
function RuleModal({
  rule,
  accounts,
  onClose,
  onSave,
}: {
  rule: any;
  accounts: any[];
  onClose: () => void;
  onSave: () => void;
}) {
  const [name, setName] = useState(rule?.name || '');
  const [platforms, setPlatforms] = useState<string[]>(rule?.platforms || ['FACEBOOK', 'INSTAGRAM']);
  const [dryRun, setDryRun] = useState(rule?.dryRun || false);
  const [keywords, setKeywords] = useState(
    rule?.conditions?.conditions
      ?.filter((c: any) => c.type === 'keyword' || c.type === 'keyword_list')
      ?.flatMap((c: any) => Array.isArray(c.value) ? c.value : [c.value])
      ?.join(', ') || ''
  );
  const [action, setAction] = useState(
    rule?.actions?.[0]?.type || 'HIDE_COMMENT'
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!name.trim() || !keywords.trim()) {
      setError('Name and keywords are required');
      return;
    }

    setSaving(true);
    setError('');

    const keywordList = keywords.split(',').map((k: string) => k.trim()).filter(Boolean);

    const ruleData = {
      name: name.trim(),
      platforms,
      triggers: ['COMMENT_CREATED'],
      conditions: {
        matchType: 'any',
        conditions: [
          {
            type: 'keyword_list',
            value: keywordList,
            caseSensitive: false,
          },
        ],
      },
      actions: [{ type: action }],
      dryRun,
      stopOnMatch: true,
    };

    try {
      const url = rule ? `/api/social/rules/${rule.id}` : '/api/social/rules';
      const method = rule ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ruleData),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save rule');
      }

      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save rule');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h3 className="text-lg font-semibold">
            {rule ? 'Edit Rule' : 'Create Rule'}
          </h3>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Rule Name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Block spam keywords"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Platforms
            </label>
            <div className="flex gap-2">
              {['FACEBOOK', 'INSTAGRAM'].map((platform) => (
                <button
                  key={platform}
                  onClick={() => {
                    if (platforms.includes(platform)) {
                      if (platforms.length > 1) {
                        setPlatforms(platforms.filter((p) => p !== platform));
                      }
                    } else {
                      setPlatforms([...platforms, platform]);
                    }
                  }}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors',
                    platforms.includes(platform)
                      ? 'bg-blue-50 border-blue-500 text-blue-700'
                      : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                  )}
                >
                  {platform === 'FACEBOOK' ? (
                    <Facebook className="w-4 h-4" />
                  ) : (
                    <Instagram className="w-4 h-4" />
                  )}
                  {platform === 'FACEBOOK' ? 'Facebook' : 'Instagram'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Keywords (comma-separated)
            </label>
            <Input
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="spam, buy now, click here"
            />
            <p className="text-xs text-gray-500 mt-1">
              Comments containing any of these keywords will trigger the rule
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Action
            </label>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg bg-white"
            >
              <option value="HIDE_COMMENT">Hide comment (Facebook only)</option>
              <option value="DELETE_COMMENT">Delete comment</option>
              <option value="ADD_LABEL">Add label "spam"</option>
              <option value="SET_STATUS">Set status to "Escalated"</option>
            </select>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              className="rounded border-gray-300"
            />
            <span className="text-sm text-gray-700">
              Dry run mode (log matches without taking action)
            </span>
          </label>

          {error && (
            <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t bg-gray-50">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            {rule ? 'Save Changes' : 'Create Rule'}
          </Button>
        </div>
      </div>
    </div>
  );
}
