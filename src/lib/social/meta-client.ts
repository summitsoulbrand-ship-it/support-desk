/**
 * Meta Graph API Client
 * Handles Facebook and Instagram API interactions
 */

import {
  MetaTokens,
  MetaPage,
  MetaComment,
  MetaPost,
  MetaAd,
  CommentActionResult,
} from './types';

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Required scopes for Social Comments feature
// Note: These permissions must be added to your app's Use Cases in Facebook Developer Console
export const META_REQUIRED_SCOPES = [
  'pages_show_list',           // List pages user manages
  'pages_read_engagement',     // Read page content, insights, followers
  'pages_read_user_content',   // Read user-generated content (comments, reactions)
  'pages_manage_engagement',   // Reply to comments, like posts
  'pages_manage_metadata',     // Webhooks, page settings
];

export interface MetaClientConfig {
  accessToken: string;
  pageAccessToken?: string;
  pageId?: string;
  instagramAccountId?: string;
}

export class MetaClient {
  private config: MetaClientConfig;

  constructor(config: MetaClientConfig) {
    this.config = config;
  }

  // ============================================================================
  // Core API Methods
  // ============================================================================

  private async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    params?: Record<string, string>,
    body?: unknown,
    usePageToken = true
  ): Promise<T> {
    const usingPageToken = usePageToken && !!this.config.pageAccessToken;
    const token = usingPageToken
      ? this.config.pageAccessToken!
      : this.config.accessToken;

    // Debug: log which token is being used (first 10 chars only for security)
    console.log(`[MetaClient.request] ${endpoint} - usingPageToken: ${usingPageToken}, tokenPrefix: ${token.substring(0, 10)}...`);

    const url = new URL(`${GRAPH_API_BASE}${endpoint}`);
    url.searchParams.set('access_token', token);

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });
    }

    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (body && method === 'POST') {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url.toString(), options);
    const data = await response.json();

    if (!response.ok) {
      const error = data.error || { message: 'Unknown error' };
      throw new Error(`Meta API error: ${error.message} (code: ${error.code || 'unknown'})`);
    }

    return data as T;
  }

  // ============================================================================
  // OAuth / Token Methods
  // ============================================================================

  /**
   * Exchange short-lived token for long-lived token
   */
  static async exchangeToken(
    appId: string,
    appSecret: string,
    shortLivedToken: string
  ): Promise<MetaTokens> {
    const url = new URL(`${GRAPH_API_BASE}/oauth/access_token`);
    url.searchParams.set('grant_type', 'fb_exchange_token');
    url.searchParams.set('client_id', appId);
    url.searchParams.set('client_secret', appSecret);
    url.searchParams.set('fb_exchange_token', shortLivedToken);

    const response = await fetch(url.toString());
    const data = await response.json();

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${data.error?.message || 'Unknown error'}`);
    }

    return {
      accessToken: data.access_token,
      tokenType: data.token_type || 'bearer',
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : undefined,
    };
  }

  /**
   * Get current user info
   */
  async getUserInfo(): Promise<{ id: string; name: string; email?: string }> {
    return this.request('/me', 'GET', { fields: 'id,name,email' }, undefined, false);
  }

  /**
   * Debug: Get token permissions
   */
  async debugTokenPermissions(): Promise<{ permissions: string[] }> {
    const response = await this.request<{
      data: Array<{ permission: string; status: string }>;
    }>('/me/permissions', 'GET', {}, undefined, false);

    const grantedPermissions = response.data
      .filter(p => p.status === 'granted')
      .map(p => p.permission);

    console.log('[MetaClient] Token permissions:', grantedPermissions);
    return { permissions: grantedPermissions };
  }

  /**
   * Debug: Check page token permissions by introspecting
   */
  async debugPageTokenInfo(): Promise<{ valid: boolean; type?: string; scopes?: string[]; error?: string }> {
    if (!this.config.pageAccessToken) {
      return { valid: false, error: 'No page token configured' };
    }

    try {
      // Try to introspect the page token by making a simple /me call with it
      const response = await this.request<{
        id: string;
        name?: string;
      }>('/me', 'GET', { fields: 'id,name' }, undefined, true);

      console.log('[MetaClient] Page token introspection - id:', response.id, 'name:', response.name);

      // Try to check permissions for page token
      try {
        const permsResponse = await this.request<{
          data: Array<{ permission: string; status: string }>;
        }>('/me/permissions', 'GET', {}, undefined, true);

        const grantedPermissions = permsResponse.data
          .filter(p => p.status === 'granted')
          .map(p => p.permission);

        console.log('[MetaClient] Page token permissions:', grantedPermissions);
        return { valid: true, type: 'page', scopes: grantedPermissions };
      } catch (permErr) {
        // Page tokens may not support /me/permissions
        console.log('[MetaClient] Page token does not support /me/permissions (normal for page tokens)');
        return { valid: true, type: 'page', scopes: ['unknown - page token'] };
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      console.log('[MetaClient] Page token error:', error);
      return { valid: false, error };
    }
  }

  /**
   * Get pages the user has access to (with page access tokens)
   */
  async getPages(): Promise<MetaPage[]> {
    console.log('[MetaClient.getPages] Fetching pages from /me/accounts...');

    const response = await this.request<{
      data: Array<{
        id: string;
        name: string;
        access_token: string;
        category?: string;
        picture?: { data: { url: string } };
        instagram_business_account?: {
          id: string;
          username: string;
          name: string;
          profile_picture_url?: string;
        };
      }>;
    }>(
      '/me/accounts',
      'GET',
      {
        fields: 'id,name,access_token,category,picture,instagram_business_account{id,username,name,profile_picture_url}',
      },
      undefined,
      false
    );

    console.log('[MetaClient.getPages] Raw response data length:', response.data?.length ?? 0);
    if (response.data?.length) {
      console.log('[MetaClient.getPages] First page:', { id: response.data[0].id, name: response.data[0].name });
    }

    return response.data.map((page) => ({
      id: page.id,
      name: page.name,
      accessToken: page.access_token,
      category: page.category,
      pictureUrl: page.picture?.data?.url,
      instagramBusinessAccount: page.instagram_business_account
        ? {
            id: page.instagram_business_account.id,
            username: page.instagram_business_account.username,
            name: page.instagram_business_account.name,
            profilePictureUrl: page.instagram_business_account.profile_picture_url,
          }
        : undefined,
    }));
  }

  /**
   * Get long-lived page access token
   */
  async getPageLongLivedToken(pageId: string): Promise<string> {
    const response = await this.request<{ access_token: string }>(
      `/${pageId}`,
      'GET',
      { fields: 'access_token' },
      undefined,
      false
    );
    return response.access_token;
  }

  /**
   * Validate token and get debug info
   */
  static async debugToken(
    inputToken: string,
    appToken: string
  ): Promise<{
    isValid: boolean;
    expiresAt?: Date;
    scopes?: string[];
    userId?: string;
    appId?: string;
  }> {
    const url = new URL(`${GRAPH_API_BASE}/debug_token`);
    url.searchParams.set('input_token', inputToken);
    url.searchParams.set('access_token', appToken);

    const response = await fetch(url.toString());
    const data = await response.json();

    if (!response.ok || !data.data) {
      return { isValid: false };
    }

    const tokenData = data.data;
    return {
      isValid: tokenData.is_valid === true,
      expiresAt: tokenData.expires_at
        ? new Date(tokenData.expires_at * 1000)
        : undefined,
      scopes: tokenData.scopes,
      userId: tokenData.user_id,
      appId: tokenData.app_id,
    };
  }

  // ============================================================================
  // Facebook Comments
  // ============================================================================

  /**
   * Get comments on a Facebook post
   */
  async getPostComments(
    postId: string,
    limit = 50,
    after?: string
  ): Promise<{ data: MetaComment[]; paging?: { cursors?: { after?: string } } }> {
    const params: Record<string, string> = {
      // Request from field with nested picture data
      fields: 'id,message,from{id,name,picture{url}},created_time,permalink_url,is_hidden,can_hide,can_remove,like_count,comment_count,attachment,parent',
      limit: String(limit),
      // Include all comments, not just top-level
      filter: 'stream',
    };
    if (after) {
      params.after = after;
    }

    // Use page token for reading comments
    const result = await this.request<{ data: MetaComment[]; paging?: { cursors?: { after?: string } } }>(
      `/${postId}/comments`, 'GET', params, undefined, true
    );

    // Debug: Log first comment to see what Meta is returning
    if (result.data?.length > 0) {
      const first = result.data[0];
      console.log(`[MetaClient.getPostComments] First comment sample:`, JSON.stringify({
        id: first.id,
        hasFrom: !!first.from,
        fromKeys: first.from ? Object.keys(first.from) : [],
        fromName: first.from?.name,
        fromId: first.from?.id,
      }));
    }

    return result;
  }

  /**
   * Get a single comment with details
   */
  async getComment(commentId: string): Promise<MetaComment> {
    const result = await this.request<MetaComment>(`/${commentId}`, 'GET', {
      fields: 'id,message,from{id,name,picture{url}},created_time,permalink_url,is_hidden,can_hide,can_remove,like_count,comment_count,attachment,parent',
    });

    // Debug: Log what Meta returned
    console.log(`[MetaClient.getComment] Comment ${commentId}:`, JSON.stringify({
      hasFrom: !!result.from,
      fromKeys: result.from ? Object.keys(result.from) : [],
      fromName: result.from?.name,
    }));

    return result;
  }

  /**
   * Reply to a Facebook comment
   */
  async replyToComment(commentId: string, message: string): Promise<CommentActionResult> {
    try {
      const result = await this.request<{ id: string }>(
        `/${commentId}/comments`,
        'POST',
        { message }
      );
      return { success: true, data: result };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  /**
   * Like a comment (as the page)
   */
  async likeComment(commentId: string): Promise<CommentActionResult> {
    try {
      await this.request(`/${commentId}/likes`, 'POST');
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  /**
   * Unlike a comment
   */
  async unlikeComment(commentId: string): Promise<CommentActionResult> {
    try {
      await this.request(`/${commentId}/likes`, 'DELETE');
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  /**
   * Hide a comment (Facebook only)
   */
  async hideComment(commentId: string): Promise<CommentActionResult> {
    try {
      await this.request(`/${commentId}`, 'POST', { is_hidden: 'true' });
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  /**
   * Unhide a comment (Facebook only)
   */
  async unhideComment(commentId: string): Promise<CommentActionResult> {
    try {
      await this.request(`/${commentId}`, 'POST', { is_hidden: 'false' });
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  /**
   * Delete a comment (if permitted)
   */
  async deleteComment(commentId: string): Promise<CommentActionResult> {
    try {
      await this.request(`/${commentId}`, 'DELETE');
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  // ============================================================================
  // Facebook Posts
  // ============================================================================

  /**
   * Get posts from a page
   */
  async getPagePosts(
    pageId: string,
    limit = 25,
    after?: string
  ): Promise<{ data: MetaPost[]; paging?: { cursors?: { after?: string } } }> {
    const params: Record<string, string> = {
      // Note: full_picture is deprecated in v21.0+, using picture instead
      fields: 'id,message,story,picture,permalink_url,created_time,is_published',
      limit: String(limit),
    };
    if (after) {
      params.after = after;
    }

    return this.request(`/${pageId}/posts`, 'GET', params);
  }

  /**
   * Get a single post
   */
  async getPost(postId: string): Promise<MetaPost> {
    return this.request(`/${postId}`, 'GET', {
      fields: 'id,message,story,full_picture,permalink_url,created_time,type,is_published,promoted_object',
    });
  }

  // ============================================================================
  // Instagram Comments
  // ============================================================================

  /**
   * Get comments on an Instagram media
   */
  async getInstagramMediaComments(
    mediaId: string,
    limit = 50,
    after?: string
  ): Promise<{ data: MetaComment[]; paging?: { cursors?: { after?: string } } }> {
    const params: Record<string, string> = {
      fields: 'id,text,timestamp,username,like_count,replies{id,text,timestamp,username,like_count}',
      limit: String(limit),
    };
    if (after) {
      params.after = after;
    }

    const response = await this.request<{
      data: Array<{
        id: string;
        text: string;
        timestamp: string;
        username: string;
        like_count?: number;
        replies?: { data: Array<{ id: string; text: string; timestamp: string; username: string; like_count?: number }> };
      }>;
      paging?: { cursors?: { after?: string } };
    }>(`/${mediaId}/comments`, 'GET', params);

    // Transform Instagram comment format to match Facebook format
    return {
      data: response.data.map((comment) => ({
        id: comment.id,
        message: comment.text,
        username: comment.username,
        created_time: comment.timestamp,
        like_count: comment.like_count,
        comment_count: comment.replies?.data?.length || 0,
      })),
      paging: response.paging,
    };
  }

  /**
   * Reply to an Instagram comment
   */
  async replyToInstagramComment(
    commentId: string,
    message: string
  ): Promise<CommentActionResult> {
    try {
      const result = await this.request<{ id: string }>(
        `/${commentId}/replies`,
        'POST',
        { message }
      );
      return { success: true, data: result };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  /**
   * Delete an Instagram comment
   */
  async deleteInstagramComment(commentId: string): Promise<CommentActionResult> {
    try {
      await this.request(`/${commentId}`, 'DELETE');
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  /**
   * Get Instagram media (posts)
   */
  async getInstagramMedia(
    accountId: string,
    limit = 25,
    after?: string
  ): Promise<{
    data: Array<{
      id: string;
      media_type: string;
      media_url?: string;
      thumbnail_url?: string;
      permalink: string;
      caption?: string;
      timestamp: string;
      comments_count?: number;
    }>;
    paging?: { cursors?: { after?: string } };
  }> {
    const params: Record<string, string> = {
      fields: 'id,media_type,media_url,thumbnail_url,permalink,caption,timestamp,comments_count',
      limit: String(limit),
    };
    if (after) {
      params.after = after;
    }

    return this.request(`/${accountId}/media`, 'GET', params);
  }

  // ============================================================================
  // Ads API
  // ============================================================================

  /**
   * Get ad info if a post is promoted
   */
  async getAdInfo(adId: string): Promise<MetaAd | null> {
    try {
      return await this.request(`/${adId}`, 'GET', {
        fields: 'id,name,adset_id,adset{id,name,campaign_id,campaign{id,name}},creative{id,name,thumbnail_url,effective_object_story_id,object_story_spec},status',
      });
    } catch {
      return null;
    }
  }

  /**
   * Get ads for a page's posts
   */
  async getAdsForPosts(
    adAccountId: string,
    postIds: string[]
  ): Promise<Map<string, MetaAd>> {
    const adMap = new Map<string, MetaAd>();

    try {
      // Query ads that target these posts
      const response = await this.request<{
        data: Array<MetaAd & { effective_object_story_id?: string }>;
      }>(
        `/act_${adAccountId}/ads`,
        'GET',
        {
          fields: 'id,name,adset_id,adset{id,name,campaign_id,campaign{id,name}},creative{id,name,thumbnail_url,effective_object_story_id,object_story_spec},status',
          filtering: JSON.stringify([
            { field: 'effective_object_story_id', operator: 'IN', value: postIds },
          ]),
          limit: '500',
        }
      );

      for (const ad of response.data) {
        const postId = ad.creative?.effective_object_story_id;
        if (postId) {
          adMap.set(postId, ad);
        }
      }
    } catch (err) {
      console.error('Error fetching ads:', err);
    }

    return adMap;
  }

  /**
   * Get all ads from an ad account (for syncing ad comments)
   */
  async getAdAccountAds(
    adAccountId: string,
    limit = 100
  ): Promise<Array<{
    id: string;
    name: string;
    status: string;
    storyId: string;
    adsetId?: string;
    adsetName?: string;
    campaignId?: string;
    campaignName?: string;
  }>> {
    const ads: Array<{
      id: string;
      name: string;
      status: string;
      storyId: string;
      adsetId?: string;
      adsetName?: string;
      campaignId?: string;
      campaignName?: string;
    }> = [];

    try {
      const response = await this.request<{
        data: Array<{
          id: string;
          name: string;
          status: string;
          creative?: {
            effective_object_story_id?: string;
            object_story_id?: string;
          };
          adset?: {
            id: string;
            name: string;
            campaign_id?: string;
            campaign?: { id: string; name: string };
          };
        }>;
        paging?: { next?: string };
      }>(
        `/act_${adAccountId}/ads`,
        'GET',
        {
          fields: 'id,name,status,creative{effective_object_story_id,object_story_id},adset{id,name,campaign_id,campaign{id,name}}',
          limit: String(limit),
        }
      );

      for (const ad of response.data || []) {
        const storyId = ad.creative?.effective_object_story_id || ad.creative?.object_story_id;
        if (storyId) {
          ads.push({
            id: ad.id,
            name: ad.name,
            status: ad.status,
            storyId,
            adsetId: ad.adset?.id,
            adsetName: ad.adset?.name,
            campaignId: ad.adset?.campaign_id || ad.adset?.campaign?.id,
            campaignName: ad.adset?.campaign?.name,
          });
        }
      }

      console.log(`[MetaClient] Found ${ads.length} ads with story IDs`);
    } catch (err) {
      console.error('Error fetching ad account ads:', err);
    }

    return ads;
  }

  // ============================================================================
  // Webhooks
  // ============================================================================

  /**
   * Subscribe a page to webhooks
   */
  async subscribePageToWebhooks(pageId: string): Promise<boolean> {
    try {
      await this.request(`/${pageId}/subscribed_apps`, 'POST', {
        subscribed_fields: 'feed,mention,comments',
      });
      return true;
    } catch (err) {
      console.error('Failed to subscribe to webhooks:', err);
      return false;
    }
  }

  /**
   * Verify webhook signature
   */
  static verifyWebhookSignature(
    payload: string,
    signature: string,
    appSecret: string
  ): boolean {
    const crypto = require('crypto');
    const expectedSignature = `sha256=${crypto
      .createHmac('sha256', appSecret)
      .update(payload)
      .digest('hex')}`;
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a Meta client from encrypted settings
 * If refreshPageToken is true, fetches a fresh page token from /me/accounts
 */
export async function createMetaClient(
  pageId?: string,
  refreshPageToken = false
): Promise<MetaClient | null> {
  // Import dynamically to avoid circular dependencies
  const { default: prisma } = await import('@/lib/db');
  const { decryptJson, encryptJson } = await import('@/lib/encryption');

  const settings = await prisma.integrationSettings.findUnique({
    where: { type: 'META' },
  });

  if (!settings?.enabled || !settings.encryptedData) {
    return null;
  }

  const config = decryptJson<{
    accessToken: string;
    appId?: string;
    appSecret?: string;
    redirectUri?: string;
    webhookVerifyToken?: string;
    configId?: string;
    userId?: string;
    pages: Array<{
      id: string;
      accessToken: string;
      instagramAccountId?: string;
    }>;
  }>(settings.encryptedData);

  console.log(`[createMetaClient] Config has accessToken: ${!!config?.accessToken}, pages: ${config?.pages?.length || 0}`);

  if (!config?.accessToken) {
    console.log(`[createMetaClient] No access token found`);
    return null;
  }

  // If pageId specified, find that page's token
  let pageAccessToken: string | undefined;
  let instagramAccountId: string | undefined;

  if (pageId && config.pages) {
    console.log(`[createMetaClient] Looking for page ${pageId} in pages:`, config.pages.map(p => p.id));
    const page = config.pages.find((p) => p.id === pageId);
    console.log(`[createMetaClient] Page found: ${!!page}, hasPageToken: ${!!page?.accessToken}`);

    if (page) {
      // If refreshPageToken is requested, get a fresh token from the API
      if (refreshPageToken) {
        console.log(`[createMetaClient] Refreshing page token from /me/accounts...`);
        try {
          const tempClient = new MetaClient({ accessToken: config.accessToken });
          const pages = await tempClient.getPages();
          const freshPage = pages.find(p => p.id === pageId);

          if (freshPage?.accessToken) {
            pageAccessToken = freshPage.accessToken;
            instagramAccountId = freshPage.instagramBusinessAccount?.id;
            console.log(`[createMetaClient] Got fresh page token (prefix: ${pageAccessToken.substring(0, 10)}...)`);

            // Update the stored config with fresh token
            const updatedPages = config.pages.map(p =>
              p.id === pageId
                ? { ...p, accessToken: freshPage.accessToken, instagramAccountId: freshPage.instagramBusinessAccount?.id }
                : p
            );

            const updatedConfig = { ...config, pages: updatedPages };
            await prisma.integrationSettings.update({
              where: { type: 'META' },
              data: { encryptedData: encryptJson(updatedConfig) },
            });
            console.log(`[createMetaClient] Updated stored page token`);
          } else {
            console.log(`[createMetaClient] Could not get fresh page token, using stored one`);
            pageAccessToken = page.accessToken;
            instagramAccountId = page.instagramAccountId;
          }
        } catch (err) {
          console.error(`[createMetaClient] Error refreshing page token:`, err);
          pageAccessToken = page.accessToken;
          instagramAccountId = page.instagramAccountId;
        }
      } else {
        pageAccessToken = page.accessToken;
        instagramAccountId = page.instagramAccountId;
      }
    }
  } else {
    console.log(`[createMetaClient] No pageId provided or no pages in config. pageId: ${pageId}, pages: ${config.pages?.length || 0}`);
  }

  return new MetaClient({
    accessToken: config.accessToken,
    pageAccessToken,
    pageId,
    instagramAccountId,
  });
}
