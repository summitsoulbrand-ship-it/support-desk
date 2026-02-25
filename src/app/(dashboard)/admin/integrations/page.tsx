'use client';

/**
 * Admin Integrations page - configure email, Shopify, Printify, Claude
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn, formatDateFull } from '@/lib/utils';
import {
  Mail,
  ShoppingCart,
  Package,
  Sparkles,
  Check,
  X,
  RefreshCw,
  Eye,
  EyeOff,
  Save,
  TestTube,
  MapPin,
  MessageCircle,
  ExternalLink,
  TrendingUp,
  Star,
  Truck,
  Send,
} from 'lucide-react';
import Link from 'next/link';

interface Integration {
  id: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
  lastTestedAt: string | null;
  testResult: string | null;
}

type IntegrationType = 'ZOHO_IMAP_SMTP' | 'SHOPIFY' | 'PRINTIFY' | 'CLAUDE' | 'SMARTYSTREETS' | 'META' | 'JUDGEME' | 'TRACKINGMORE' | 'RESEND';

const integrationMeta: Record<
  IntegrationType,
  { name: string; icon: React.ElementType; description: string }
> = {
  ZOHO_IMAP_SMTP: {
    name: 'Zoho Email (IMAP/SMTP)',
    icon: Mail,
    description: 'Connect to Zoho Mail for email sync and sending',
  },
  SHOPIFY: {
    name: 'Shopify',
    icon: ShoppingCart,
    description: 'Access customer and order data from your store',
  },
  PRINTIFY: {
    name: 'Printify',
    icon: Package,
    description: 'View production and fulfillment status',
  },
  CLAUDE: {
    name: 'Claude AI',
    icon: Sparkles,
    description: 'Generate suggested replies with AI',
  },
  SMARTYSTREETS: {
    name: 'SmartyStreets',
    icon: MapPin,
    description: 'Address autocomplete for shipping addresses',
  },
  META: {
    name: 'Meta (Facebook/Instagram)',
    icon: MessageCircle,
    description: 'Manage comments from Facebook Pages and Instagram',
  },
  JUDGEME: {
    name: 'Judge.me',
    icon: Star,
    description: 'View customer product reviews from Judge.me',
  },
  TRACKINGMORE: {
    name: 'TrackingMore',
    icon: Truck,
    description: 'On-demand shipment tracking with real-time carrier data',
  },
  RESEND: {
    name: 'Resend',
    icon: Send,
    description: 'Send outbound emails via Resend API (bypasses SMTP blocking)',
  },
};

export default function IntegrationsPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<IntegrationType>('ZOHO_IMAP_SMTP');
  const [showSecrets, setShowSecrets] = useState(false);
  const [formData, setFormData] = useState<Record<string, unknown>>({});

  const { data: integrations, isLoading } = useQuery<Integration[]>({
    queryKey: ['integrations'],
    queryFn: async () => {
      const res = await fetch('/api/admin/integrations');
      if (!res.ok) throw new Error('Failed to fetch integrations');
      return res.json();
    },
  });

  const { data: printifySyncStatus } = useQuery<{
    totalOrders: number;
    lastSyncedAt: string | null;
  }>({
    queryKey: ['printify-sync-status'],
    queryFn: async () => {
      const res = await fetch('/api/admin/printify/sync');
      if (!res.ok) throw new Error('Failed to fetch Printify sync status');
      return res.json();
    },
    enabled: activeTab === 'PRINTIFY',
  });

  const saveMutation = useMutation({
    mutationFn: async ({
      type,
      config,
      enabled,
    }: {
      type: IntegrationType;
      config: Record<string, unknown>;
      enabled: boolean;
    }) => {
      const res = await fetch('/api/admin/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, config, enabled }),
      });
      if (!res.ok) {
        const err = await res.json();
        // Include validation details if available
        let message = err.error || 'Failed to save';
        if (err.details && Array.isArray(err.details)) {
          const details = err.details.map((d: { path?: string[]; message?: string }) =>
            `${d.path?.join('.') || 'field'}: ${d.message || 'invalid'}`
          ).join(', ');
          message = `${message}: ${details}`;
        }
        throw new Error(message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
  });

  const testMutation = useMutation({
    mutationFn: async (type: IntegrationType) => {
      const res = await fetch('/api/admin/integrations/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Test failed');
      }
      if (!data.success) {
        throw new Error(data.error || 'Test failed');
      }
      return data;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
  });

  const printifySyncMutation = useMutation({
    mutationFn: async (options?: { fullSync?: boolean; forceRefresh?: boolean }) => {
      const res = await fetch('/api/admin/printify/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options || {}),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.details || data.error || 'Printify sync failed');
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['printify-sync-status'] });
    },
  });

  const activeIntegration = integrations?.find((i) => i.type === activeTab);
  const meta = integrationMeta[activeTab];
  const Icon = meta.icon;

  const handleSave = () => {
    saveMutation.mutate({
      type: activeTab,
      config: formData,
      enabled: true,
    });
  };

  const handleTest = () => {
    testMutation.mutate(activeTab);
  };

  // Initialize form data when integration changes
  const initFormData = (type: IntegrationType) => {
    const integration = integrations?.find((i) => i.type === type);
    if (integration) {
      setFormData(integration.config || {});
    } else {
      // Set defaults
      switch (type) {
        case 'ZOHO_IMAP_SMTP':
          setFormData({
            imapHost: 'imappro.zoho.com',
            imapPort: 993,
            imapTls: true,
            smtpHost: 'smtppro.zoho.com',
            smtpPort: 465,
            smtpTls: true,
            username: '',
            password: '',
            folder: 'INBOX',
          });
          break;
        case 'SHOPIFY':
          setFormData({ storeDomain: '', accessToken: '' });
          break;
        case 'PRINTIFY':
          setFormData({ apiToken: '', shopId: '' });
          break;
        case 'CLAUDE':
          setFormData({ apiKey: '', model: 'claude-sonnet-4-20250514', projectId: '', customPrompt: '' });
          break;
        case 'SMARTYSTREETS':
          setFormData({ authId: '', authToken: '' });
          break;
        case 'META':
          setFormData({ appId: '', appSecret: '', redirectUri: `${typeof window !== 'undefined' ? window.location.origin : ''}/admin/social/callback`, webhookVerifyToken: '', configId: '' });
          break;
        case 'JUDGEME':
          setFormData({ apiToken: '', shopDomain: '' });
          break;
        case 'TRACKINGMORE':
          setFormData({ apiKey: '' });
          break;
        case 'RESEND':
          setFormData({ apiKey: '', fromEmail: '', fromName: '' });
          break;
      }
    }
  };

  // When tab changes, init form data
  const handleTabChange = (type: IntegrationType) => {
    setActiveTab(type);
    initFormData(type);
  };

  // Init on first load
  if (integrations && Object.keys(formData).length === 0) {
    initFormData(activeTab);
  }

  const renderZohoForm = () => (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            IMAP Host
          </label>
          <Input
            value={(formData.imapHost as string) || ''}
            onChange={(e) => setFormData({ ...formData, imapHost: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            IMAP Port
          </label>
          <Input
            type="number"
            value={(formData.imapPort as number) || 993}
            onChange={(e) =>
              setFormData({ ...formData, imapPort: parseInt(e.target.value) })
            }
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            SMTP Host
          </label>
          <Input
            value={(formData.smtpHost as string) || ''}
            onChange={(e) => setFormData({ ...formData, smtpHost: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            SMTP Port
          </label>
          <Input
            type="number"
            value={(formData.smtpPort as number) || 465}
            onChange={(e) =>
              setFormData({ ...formData, smtpPort: parseInt(e.target.value) })
            }
          />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Email Address
        </label>
        <Input
          type="email"
          value={(formData.username as string) || ''}
          onChange={(e) => setFormData({ ...formData, username: e.target.value })}
          placeholder="support@yourdomain.com"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          App Password
        </label>
        <div className="relative">
          <Input
            type={showSecrets ? 'text' : 'password'}
            value={(formData.password as string) || ''}
            onChange={(e) => setFormData({ ...formData, password: e.target.value })}
            placeholder="Your Zoho app password"
          />
          <button
            type="button"
            onClick={() => setShowSecrets(!showSecrets)}
            className="absolute right-3 top-1/2 transform -translate-y-1/2"
          >
            {showSecrets ? (
              <EyeOff className="w-4 h-4 text-gray-400" />
            ) : (
              <Eye className="w-4 h-4 text-gray-400" />
            )}
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-1">
          Create an app password in Zoho Mail settings
        </p>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          IMAP Folder
        </label>
        <Input
          value={(formData.folder as string) || ''}
          onChange={(e) => setFormData({ ...formData, folder: e.target.value })}
          placeholder="INBOX"
        />
        <p className="text-xs text-gray-600 mt-1">
          Use the folder where new mail arrives (e.g. INBOX, Spam, or INBOX/Support)
        </p>
      </div>
    </div>
  );

  const renderShopifyForm = () => (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Store Domain
        </label>
        <Input
          value={(formData.storeDomain as string) || ''}
          onChange={(e) =>
            setFormData({ ...formData, storeDomain: e.target.value })
          }
          placeholder="your-store.myshopify.com"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Admin API Access Token
        </label>
        <div className="relative">
          <Input
            type={showSecrets ? 'text' : 'password'}
            value={(formData.accessToken as string) || ''}
            onChange={(e) =>
              setFormData({ ...formData, accessToken: e.target.value })
            }
            placeholder="shpat_..."
          />
          <button
            type="button"
            onClick={() => setShowSecrets(!showSecrets)}
            className="absolute right-3 top-1/2 transform -translate-y-1/2"
          >
            {showSecrets ? (
              <EyeOff className="w-4 h-4 text-gray-400" />
            ) : (
              <Eye className="w-4 h-4 text-gray-400" />
            )}
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-1">
          Create a custom app in Shopify Admin with read_customers and read_orders
          scopes
        </p>
      </div>
    </div>
  );

  const renderPrintifyForm = () => (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          API Token
        </label>
        <div className="relative">
          <Input
            type={showSecrets ? 'text' : 'password'}
            value={(formData.apiToken as string) || ''}
            onChange={(e) =>
              setFormData({ ...formData, apiToken: e.target.value })
            }
            placeholder="Your Printify API token"
          />
          <button
            type="button"
            onClick={() => setShowSecrets(!showSecrets)}
            className="absolute right-3 top-1/2 transform -translate-y-1/2"
          >
            {showSecrets ? (
              <EyeOff className="w-4 h-4 text-gray-400" />
            ) : (
              <Eye className="w-4 h-4 text-gray-400" />
            )}
          </button>
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Shop ID
        </label>
        <Input
          value={(formData.shopId as string) || ''}
          onChange={(e) => setFormData({ ...formData, shopId: e.target.value })}
          placeholder="Your Printify shop ID"
        />
        <p className="text-xs text-gray-600 mt-1">
          Find this in your Printify dashboard URL
        </p>
      </div>

      <div className="flex items-center justify-between rounded-lg border bg-gray-50 px-3 py-2">
        <div>
          <p className="text-sm font-medium text-gray-900">
            Printify order cache
          </p>
          <p className="text-xs text-gray-600">
            {printifySyncStatus?.lastSyncedAt
              ? `Last synced ${formatDateFull(printifySyncStatus.lastSyncedAt)}`
              : 'Not synced yet'}
            {typeof printifySyncStatus?.totalOrders === 'number'
              ? ` · ${printifySyncStatus.totalOrders} orders`
              : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => printifySyncMutation.mutate({})}
            loading={printifySyncMutation.isPending}
            disabled={printifySyncMutation.isPending}
          >
            Sync
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => printifySyncMutation.mutate({ fullSync: true, forceRefresh: true })}
            loading={printifySyncMutation.isPending}
            disabled={printifySyncMutation.isPending}
          >
            Full Refresh
          </Button>
        </div>
      </div>

      {printifySyncMutation.error && (
        <p className="text-sm text-red-500">
          {printifySyncMutation.error.message}
        </p>
      )}

      <Link
        href="/admin/printify-insights"
        className="flex items-center gap-2 text-sm text-purple-600 hover:text-purple-800 font-medium"
      >
        <TrendingUp className="w-4 h-4" />
        View Printify Insights & Analytics
        <ExternalLink className="w-3 h-3" />
      </Link>
    </div>
  );

  const renderClaudeForm = () => (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          API Key
        </label>
        <div className="relative">
          <Input
            type={showSecrets ? 'text' : 'password'}
            value={(formData.apiKey as string) || ''}
            onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
            placeholder="sk-ant-..."
          />
          <button
            type="button"
            onClick={() => setShowSecrets(!showSecrets)}
            className="absolute right-3 top-1/2 transform -translate-y-1/2"
          >
            {showSecrets ? (
              <EyeOff className="w-4 h-4 text-gray-400" />
            ) : (
              <Eye className="w-4 h-4 text-gray-400" />
            )}
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-1">
          Get your API key from console.anthropic.com
        </p>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Model
        </label>
        <select
          value={(formData.model as string) || 'claude-sonnet-4-20250514'}
          onChange={(e) => setFormData({ ...formData, model: e.target.value })}
          className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="claude-sonnet-4-20250514">Claude Sonnet 4 (Recommended)</option>
          <option value="claude-3-5-haiku-20241022">Claude 3.5 Haiku (Faster)</option>
          <option value="claude-opus-4-20250514">Claude Opus 4 (Most capable)</option>
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Project ID (Optional)
        </label>
        <Input
          value={(formData.projectId as string) || ''}
          onChange={(e) => setFormData({ ...formData, projectId: e.target.value })}
          placeholder="proj_..."
        />
        <p className="text-xs text-gray-600 mt-1">
          For billing/organization purposes. Find this in your Anthropic console under Projects.
        </p>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Custom System Prompt (Optional)
        </label>
        <textarea
          value={(formData.customPrompt as string) || ''}
          onChange={(e) => setFormData({ ...formData, customPrompt: e.target.value })}
          placeholder="Enter your custom instructions for Claude here... Leave empty to use the default customer service prompt."
          rows={8}
          className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm font-mono"
        />
        <p className="text-xs text-gray-600 mt-1">
          Override the default system prompt with your own. This is where you define Claude&apos;s personality, tone, and response guidelines. Leave empty to use the built-in customer service prompt.
        </p>
      </div>
    </div>
  );

  const renderSmartyStreetsForm = () => (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Auth ID
        </label>
        <Input
          value={(formData.authId as string) || ''}
          onChange={(e) => setFormData({ ...formData, authId: e.target.value })}
          placeholder="Your SmartyStreets Auth ID"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Auth Token
        </label>
        <div className="relative">
          <Input
            type={showSecrets ? 'text' : 'password'}
            value={(formData.authToken as string) || ''}
            onChange={(e) => setFormData({ ...formData, authToken: e.target.value })}
            placeholder="Your SmartyStreets Auth Token"
          />
          <button
            type="button"
            onClick={() => setShowSecrets(!showSecrets)}
            className="absolute right-3 top-1/2 transform -translate-y-1/2"
          >
            {showSecrets ? (
              <EyeOff className="w-4 h-4 text-gray-400" />
            ) : (
              <Eye className="w-4 h-4 text-gray-400" />
            )}
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-1">
          Get your credentials from smarty.com/account/keys (use Secret Keys, not Embedded Keys)
        </p>
      </div>
    </div>
  );

  const renderMetaForm = () => (
    <div className="space-y-4">
      <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700">
        <p className="font-medium mb-1">Setup Instructions</p>
        <ol className="list-decimal list-inside space-y-1 text-blue-600">
          <li>Create a Meta App at <a href="https://developers.facebook.com/" target="_blank" rel="noopener noreferrer" className="underline">developers.facebook.com</a></li>
          <li>Add &quot;Facebook Login for Business&quot; product</li>
          <li>Set OAuth Redirect URI to match the Redirect URI below</li>
          <li>Add required permissions: pages_show_list, pages_read_engagement, pages_manage_engagement</li>
        </ol>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          App ID
        </label>
        <Input
          value={(formData.appId as string) || ''}
          onChange={(e) => setFormData({ ...formData, appId: e.target.value })}
          placeholder="Your Meta App ID"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          App Secret
        </label>
        <div className="relative">
          <Input
            type={showSecrets ? 'text' : 'password'}
            value={(formData.appSecret as string) || ''}
            onChange={(e) => setFormData({ ...formData, appSecret: e.target.value })}
            placeholder="Your Meta App Secret"
          />
          <button
            type="button"
            onClick={() => setShowSecrets(!showSecrets)}
            className="absolute right-3 top-1/2 transform -translate-y-1/2"
          >
            {showSecrets ? (
              <EyeOff className="w-4 h-4 text-gray-400" />
            ) : (
              <Eye className="w-4 h-4 text-gray-400" />
            )}
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-1">
          Find this in Settings &gt; Basic in your Meta App Dashboard
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          OAuth Redirect URI
        </label>
        <Input
          value={(formData.redirectUri as string) || ''}
          onChange={(e) => setFormData({ ...formData, redirectUri: e.target.value })}
          placeholder="https://yourdomain.com/admin/social/callback"
        />
        <p className="text-xs text-gray-600 mt-1">
          Add this URL to your Meta App&apos;s Valid OAuth Redirect URIs
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Webhook Verify Token (Optional)
        </label>
        <Input
          value={(formData.webhookVerifyToken as string) || ''}
          onChange={(e) => setFormData({ ...formData, webhookVerifyToken: e.target.value })}
          placeholder="A random string for webhook verification"
        />
        <p className="text-xs text-gray-600 mt-1">
          Required only if you want real-time comment notifications via webhooks
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Configuration ID (Optional)
        </label>
        <Input
          value={(formData.configId as string) || ''}
          onChange={(e) => setFormData({ ...formData, configId: e.target.value })}
          placeholder="Facebook Login for Business config ID"
        />
        <p className="text-xs text-gray-600 mt-1">
          From Facebook Login for Business configuration (if using system-user tokens)
        </p>
      </div>

      <div className="flex items-center justify-between rounded-lg border bg-gray-50 px-3 py-2">
        <div>
          <p className="text-sm font-medium text-gray-900">
            Connect Facebook Pages
          </p>
          <p className="text-xs text-gray-600">
            After saving, connect your pages in Social Settings
          </p>
        </div>
        <Link href="/admin/social">
          <Button variant="secondary" size="sm">
            <ExternalLink className="w-4 h-4 mr-1" />
            Social Settings
          </Button>
        </Link>
      </div>
    </div>
  );

  const renderJudgemeForm = () => (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Shop Domain
        </label>
        <Input
          value={(formData.shopDomain as string) || ''}
          onChange={(e) => setFormData({ ...formData, shopDomain: e.target.value })}
          placeholder="your-store.myshopify.com"
        />
        <p className="text-xs text-gray-600 mt-1">
          Your Shopify store domain (same as in Shopify integration)
        </p>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          API Token
        </label>
        <div className="relative">
          <Input
            type={showSecrets ? 'text' : 'password'}
            value={(formData.apiToken as string) || ''}
            onChange={(e) => setFormData({ ...formData, apiToken: e.target.value })}
            placeholder="Your Judge.me API token"
          />
          <button
            type="button"
            onClick={() => setShowSecrets(!showSecrets)}
            className="absolute right-3 top-1/2 transform -translate-y-1/2"
          >
            {showSecrets ? (
              <EyeOff className="w-4 h-4 text-gray-400" />
            ) : (
              <Eye className="w-4 h-4 text-gray-400" />
            )}
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-1">
          Find your API token in Judge.me Settings &gt; API &gt; API Token
        </p>
      </div>
    </div>
  );

  const renderTrackingMoreForm = () => (
    <div className="space-y-4">
      <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700">
        <p className="font-medium mb-1">On-Demand Tracking</p>
        <p className="text-blue-600">
          TrackingMore provides real-time shipment tracking data. API calls are only made when you click &quot;Get Tracking Details&quot; in the order sidebar, helping conserve your API credits.
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          API Key
        </label>
        <div className="relative">
          <Input
            type={showSecrets ? 'text' : 'password'}
            value={(formData.apiKey as string) || ''}
            onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
            placeholder="Your TrackingMore API key"
          />
          <button
            type="button"
            onClick={() => setShowSecrets(!showSecrets)}
            className="absolute right-3 top-1/2 transform -translate-y-1/2"
          >
            {showSecrets ? (
              <EyeOff className="w-4 h-4 text-gray-400" />
            ) : (
              <Eye className="w-4 h-4 text-gray-400" />
            )}
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-1">
          Get your API key from{' '}
          <a
            href="https://www.trackingmore.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
          >
            trackingmore.com
          </a>
          {' '}(free tier: 200 trackings/month)
        </p>
      </div>

      <div className="p-3 bg-gray-50 border rounded-lg">
        <p className="text-sm font-medium text-gray-900 mb-2">Supported Carriers</p>
        <p className="text-xs text-gray-600">
          USPS, UPS, FedEx, DHL, OnTrac, LaserShip, and 1,100+ other carriers worldwide.
        </p>
      </div>
    </div>
  );

  const renderResendForm = () => (
    <div className="space-y-4">
      <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700">
        <p className="font-medium mb-1">Bypass SMTP Blocking</p>
        <p className="text-blue-600">
          Resend uses HTTP API to send emails, which works on cloud platforms like Railway that block outbound SMTP. Zoho IMAP will still be used to receive emails.
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          API Key
        </label>
        <div className="relative">
          <Input
            type={showSecrets ? 'text' : 'password'}
            value={(formData.apiKey as string) || ''}
            onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
            placeholder="re_..."
          />
          <button
            type="button"
            onClick={() => setShowSecrets(!showSecrets)}
            className="absolute right-3 top-1/2 transform -translate-y-1/2"
          >
            {showSecrets ? (
              <EyeOff className="w-4 h-4 text-gray-400" />
            ) : (
              <Eye className="w-4 h-4 text-gray-400" />
            )}
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-1">
          Get your API key from{' '}
          <a
            href="https://resend.com/api-keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
          >
            resend.com/api-keys
          </a>
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          From Email Address
        </label>
        <Input
          type="email"
          value={(formData.fromEmail as string) || ''}
          onChange={(e) => setFormData({ ...formData, fromEmail: e.target.value })}
          placeholder="support@yourdomain.com"
        />
        <p className="text-xs text-gray-600 mt-1">
          Must be from a verified domain in Resend. Add your domain at{' '}
          <a
            href="https://resend.com/domains"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
          >
            resend.com/domains
          </a>
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          From Name (Optional)
        </label>
        <Input
          value={(formData.fromName as string) || ''}
          onChange={(e) => setFormData({ ...formData, fromName: e.target.value })}
          placeholder="Summit Soul Support"
        />
        <p className="text-xs text-gray-600 mt-1">
          The display name shown to email recipients
        </p>
      </div>

      <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
        <p className="font-medium mb-1">Free Tier</p>
        <p className="text-green-600">
          Resend offers 3,000 emails/month for free, which should be plenty for most support desks.
        </p>
      </div>
    </div>
  );

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Integrations</h1>

      <div className="flex gap-6">
        {/* Tabs */}
        <div className="w-48 space-y-1">
          {(Object.keys(integrationMeta) as IntegrationType[]).map((type) => {
            const { name, icon: TabIcon } = integrationMeta[type];
            const integration = integrations?.find((i) => i.type === type);

            return (
              <button
                key={type}
                onClick={() => handleTabChange(type)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left',
                  activeTab === type
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-900 hover:bg-gray-100 hover:text-gray-900'
                )}
              >
                <TabIcon className="w-5 h-5" />
                <span className="flex-1">{name}</span>
                {integration?.enabled && (
                  <Check className="w-4 h-4 text-green-500" />
                )}
              </button>
            );
          })}
        </div>

        {/* Form */}
        <div className="flex-1 bg-white rounded-lg border p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
              <Icon className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h2 className="font-semibold text-gray-900">{meta.name}</h2>
              <p className="text-sm text-gray-700">{meta.description}</p>
            </div>
            {activeIntegration && (
              <div className="ml-auto">
                {activeIntegration.testResult === 'success' ? (
                  <Badge variant="success">Connected</Badge>
                ) : activeIntegration.testResult ? (
                  <Badge variant="error">Error</Badge>
                ) : (
                  <Badge variant="default">Not tested</Badge>
                )}
              </div>
            )}
          </div>

          <div className="border-t pt-4">
            {activeTab === 'ZOHO_IMAP_SMTP' && renderZohoForm()}
            {activeTab === 'SHOPIFY' && renderShopifyForm()}
            {activeTab === 'PRINTIFY' && renderPrintifyForm()}
            {activeTab === 'CLAUDE' && renderClaudeForm()}
            {activeTab === 'SMARTYSTREETS' && renderSmartyStreetsForm()}
            {activeTab === 'META' && renderMetaForm()}
            {activeTab === 'JUDGEME' && renderJudgemeForm()}
            {activeTab === 'TRACKINGMORE' && renderTrackingMoreForm()}
            {activeTab === 'RESEND' && renderResendForm()}
          </div>

          <div className="flex items-center gap-3 mt-6 pt-4 border-t">
            <Button
              onClick={handleSave}
              loading={saveMutation.isPending}
              disabled={saveMutation.isPending}
            >
              <Save className="w-4 h-4 mr-2" />
              Save
            </Button>
            <Button
              variant="secondary"
              onClick={handleTest}
              loading={testMutation.isPending}
              disabled={testMutation.isPending || !activeIntegration}
            >
              <TestTube className="w-4 h-4 mr-2" />
              Test Connection
            </Button>

            {(saveMutation.error || testMutation.error) && (
              <span className="text-sm text-red-500">
                {saveMutation.error?.message || testMutation.error?.message}
              </span>
            )}

            {testMutation.data?.success && (
              <span className="text-sm text-green-500 flex items-center gap-1">
                <Check className="w-4 h-4" />
                Connection successful
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
