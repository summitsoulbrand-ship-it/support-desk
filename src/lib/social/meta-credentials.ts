/**
 * Meta app credentials, shared by the OAuth routes and the webhook receiver.
 * Database (Admin > Integrations > Meta, encrypted at rest) first, env vars
 * as fallback/override.
 */

import prisma from '@/lib/db';
import { decryptJson } from '@/lib/encryption';

export interface MetaCredentials {
  appId: string;
  appSecret: string;
  redirectUri: string;
  webhookVerifyToken: string;
  configId?: string;
}

export async function getMetaCredentials(): Promise<MetaCredentials | null> {
  // Try database first
  const settings = await prisma.integrationSettings.findUnique({
    where: { type: 'META' },
  });

  console.log('[getMetaCredentials] Settings found:', !!settings, 'enabled:', settings?.enabled, 'hasData:', !!settings?.encryptedData);

  // Read credentials even if integration is disabled - we need them to start OAuth
  if (settings?.encryptedData) {
    try {
      const config = decryptJson(settings.encryptedData) as {
        appId?: string;
        appSecret?: string;
        redirectUri?: string;
        webhookVerifyToken?: string;
        configId?: string;
      };
      console.log('[getMetaCredentials] Decrypted config keys:', Object.keys(config), 'hasAppId:', !!config.appId, 'hasSecret:', !!config.appSecret, 'hasRedirectUri:', !!config.redirectUri);
      if (config.appId && config.appSecret && config.redirectUri) {
        return {
          appId: config.appId,
          appSecret: config.appSecret,
          redirectUri: config.redirectUri,
          webhookVerifyToken: config.webhookVerifyToken || '',
          configId: config.configId,
        };
      }
    } catch (err) {
      console.error('[getMetaCredentials] Decryption error:', err);
      // Fall through to env vars
    }
  }

  // Fall back to environment variables
  const appId = process.env.META_APP_ID || '';
  const appSecret = process.env.META_APP_SECRET || '';
  const redirectUri = process.env.META_REDIRECT_URI || '';

  console.log('[getMetaCredentials] Env vars - hasAppId:', !!appId, 'hasSecret:', !!appSecret, 'hasRedirectUri:', !!redirectUri);

  if (appId && appSecret && redirectUri) {
    return {
      appId,
      appSecret,
      redirectUri,
      webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || '',
      configId: process.env.META_CONFIG_ID,
    };
  }

  return null;
}
