/**
 * Meta OAuth Routes
 * Handle Facebook/Instagram OAuth flow
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { encryptJson, decryptJson } from '@/lib/encryption';
import { MetaClient, META_REQUIRED_SCOPES } from '@/lib/social/meta-client';

// Helper to get Meta credentials from database or environment
async function getMetaCredentials(): Promise<{
  appId: string;
  appSecret: string;
  redirectUri: string;
  webhookVerifyToken: string;
  configId?: string;
} | null> {
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

/**
 * GET - Get OAuth URL or current connection status
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'MANAGE_INTEGRATIONS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const action = request.nextUrl.searchParams.get('action');

    if (action === 'auth_url') {
      // Get credentials from database or environment
      const creds = await getMetaCredentials();
      if (!creds) {
        return NextResponse.json(
          { error: 'Meta app not configured. Please add your App ID and App Secret in Admin > Integrations > Meta.' },
          { status: 400 }
        );
      }

      const state = crypto.randomUUID();

      // Store state in session for CSRF protection (in production, use secure storage)
      // For now, we'll include it in the URL and verify on callback

      const scopes = META_REQUIRED_SCOPES.join(',');
      let authUrl = `https://www.facebook.com/v21.0/dialog/oauth?` +
        `client_id=${creds.appId}` +
        `&redirect_uri=${encodeURIComponent(creds.redirectUri)}` +
        `&scope=${encodeURIComponent(scopes)}` +
        `&state=${state}` +
        `&response_type=code` +
        `&auth_type=rerequest`;

      // TEMPORARILY DISABLED: Facebook Login for Business config_id
      // The config_id might be limiting permissions. Testing with standard OAuth.
      // if (creds.configId) {
      //   authUrl += `&config_id=${creds.configId}`;
      // }

      console.log('[Meta OAuth] Generated auth URL:', authUrl);
      console.log('[Meta OAuth] Config ID:', creds.configId || 'NOT SET');

      return NextResponse.json({ authUrl, state });
    }

    // Get current connection status
    const settings = await prisma.integrationSettings.findUnique({
      where: { type: 'META' },
    });

    if (!settings?.enabled) {
      return NextResponse.json({
        connected: false,
        accounts: [],
      });
    }

    // Get connected accounts
    const accounts = await prisma.socialAccount.findMany({
      where: { enabled: true },
      select: {
        id: true,
        platform: true,
        accountType: true,
        name: true,
        username: true,
        profilePictureUrl: true,
        webhookEnabled: true,
        lastSyncAt: true,
        syncError: true,
      },
    });

    return NextResponse.json({
      connected: true,
      accounts,
    });
  } catch (err) {
    console.error('Error in social auth GET:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * POST - Handle OAuth callback or token exchange
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'MANAGE_INTEGRATIONS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const { code, selectedPageIds } = body;

    console.log('[Meta OAuth POST] Received body keys:', Object.keys(body));

    // Get credentials
    const creds = await getMetaCredentials();

    if (code) {
      console.log('[Meta OAuth POST] Exchanging code for token...');
      // Exchange code for token
      if (!creds) {
        return NextResponse.json(
          { error: 'Meta app not configured' },
          { status: 400 }
        );
      }

      // Exchange code for short-lived token
      const tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?` +
        `client_id=${creds.appId}` +
        `&redirect_uri=${encodeURIComponent(creds.redirectUri)}` +
        `&client_secret=${creds.appSecret}` +
        `&code=${code}`;

      const tokenResponse = await fetch(tokenUrl);
      const tokenData = await tokenResponse.json();

      if (tokenData.error) {
        return NextResponse.json(
          { error: tokenData.error.message },
          { status: 400 }
        );
      }

      // Exchange for long-lived token (lasts ~60 days)
      const longLivedToken = await MetaClient.exchangeToken(
        creds.appId,
        creds.appSecret,
        tokenData.access_token
      );

      // Get user info and pages
      const client = new MetaClient({ accessToken: longLivedToken.accessToken });
      const userInfo = await client.getUserInfo();

      console.log('[Meta OAuth] User info:', userInfo);

      // Debug: Check what permissions were actually granted
      const { permissions } = await client.debugTokenPermissions();
      console.log('[Meta OAuth] GRANTED PERMISSIONS:', permissions);

      const pages = await client.getPages();

      console.log('[Meta OAuth] Pages returned:', pages.length, pages.map(p => ({ id: p.id, name: p.name })));

      // If no pages found, provide helpful error
      if (pages.length === 0) {
        return NextResponse.json({
          success: false,
          error: 'No Facebook Pages found. Make sure you have admin access to at least one Facebook Page, and that you granted the "pages_show_list" permission during login.',
          userId: userInfo.id,
          userName: userInfo.name,
        }, { status: 400 });
      }

      // Return pages for selection
      return NextResponse.json({
        success: true,
        userId: userInfo.id,
        userName: userInfo.name,
        pages: pages.map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category,
          pictureUrl: p.pictureUrl,
          hasInstagram: !!p.instagramBusinessAccount,
          instagramAccount: p.instagramBusinessAccount,
        })),
        // Store token temporarily for the next step
        tempToken: longLivedToken.accessToken,
      });
    }

    if (selectedPageIds && body.tempToken) {
      // Save selected pages
      const client = new MetaClient({ accessToken: body.tempToken });
      const pages = await client.getPages();

      const selectedPages = pages.filter((p) => selectedPageIds.includes(p.id));

      if (selectedPages.length === 0) {
        return NextResponse.json(
          { error: 'No valid pages selected' },
          { status: 400 }
        );
      }

      // Prepare page data for storage
      const pageData = selectedPages.map((p) => ({
        id: p.id,
        accessToken: p.accessToken,
        instagramAccountId: p.instagramBusinessAccount?.id,
      }));

      // Get existing credentials to preserve them
      const existingSettings = await prisma.integrationSettings.findUnique({
        where: { type: 'META' },
      });

      let existingConfig: Record<string, unknown> = {};
      if (existingSettings?.encryptedData) {
        try {
          existingConfig = decryptJson(existingSettings.encryptedData);
        } catch {
          // Ignore decryption errors
        }
      }

      // Store encrypted credentials - merge with existing app credentials
      const encryptedData = encryptJson({
        // Preserve app credentials
        appId: existingConfig.appId,
        appSecret: existingConfig.appSecret,
        redirectUri: existingConfig.redirectUri,
        webhookVerifyToken: existingConfig.webhookVerifyToken,
        configId: existingConfig.configId,
        // Add OAuth data
        accessToken: body.tempToken,
        userId: body.userId,
        pages: pageData,
      });

      await prisma.integrationSettings.upsert({
        where: { type: 'META' },
        create: {
          type: 'META',
          encryptedData,
          enabled: true,
        },
        update: {
          encryptedData,
          enabled: true,
        },
      });

      // Create social accounts for each page/IG account
      for (const page of selectedPages) {
        // Create Facebook Page account
        await prisma.socialAccount.upsert({
          where: {
            platform_externalId: {
              platform: 'FACEBOOK',
              externalId: page.id,
            },
          },
          create: {
            platform: 'FACEBOOK',
            accountType: 'FACEBOOK_PAGE',
            externalId: page.id,
            name: page.name,
            profilePictureUrl: page.pictureUrl,
            accessTokenRef: page.id,
            enabled: true,
          },
          update: {
            name: page.name,
            profilePictureUrl: page.pictureUrl,
            enabled: true,
          },
        });

        // Create Instagram Business account if linked
        if (page.instagramBusinessAccount) {
          await prisma.socialAccount.upsert({
            where: {
              platform_externalId: {
                platform: 'INSTAGRAM',
                externalId: page.instagramBusinessAccount.id,
              },
            },
            create: {
              platform: 'INSTAGRAM',
              accountType: 'INSTAGRAM_BUSINESS',
              externalId: page.instagramBusinessAccount.id,
              name: page.instagramBusinessAccount.name,
              username: page.instagramBusinessAccount.username,
              profilePictureUrl: page.instagramBusinessAccount.profilePictureUrl,
              accessTokenRef: page.id, // Uses parent page token
              enabled: true,
            },
            update: {
              name: page.instagramBusinessAccount.name,
              username: page.instagramBusinessAccount.username,
              profilePictureUrl: page.instagramBusinessAccount.profilePictureUrl,
              enabled: true,
            },
          });
        }

        // Subscribe page to webhooks
        try {
          const pageClient = new MetaClient({
            accessToken: body.tempToken,
            pageAccessToken: page.accessToken,
            pageId: page.id,
          });
          const subscribed = await pageClient.subscribePageToWebhooks(page.id);

          if (subscribed) {
            await prisma.socialAccount.update({
              where: {
                platform_externalId: {
                  platform: 'FACEBOOK',
                  externalId: page.id,
                },
              },
              data: { webhookEnabled: true },
            });
          }
        } catch (err) {
          console.error(`Failed to subscribe page ${page.id} to webhooks:`, err);
        }
      }

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  } catch (err) {
    console.error('Error in social auth POST:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Disconnect Meta integration
 */
export async function DELETE() {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'MANAGE_INTEGRATIONS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Disable all social accounts
    await prisma.socialAccount.updateMany({
      data: { enabled: false },
    });

    // Disable integration
    await prisma.integrationSettings.update({
      where: { type: 'META' },
      data: { enabled: false },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error disconnecting Meta:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
