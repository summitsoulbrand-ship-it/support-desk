/**
 * Social Comments Sync - Fetch and store comments from Meta
 */

import prisma from '@/lib/db';
import { MetaClient, createMetaClient } from './meta-client';
import { processCommentRules } from './rules-engine';
import type { MetaComment, MetaPost, MetaAd } from './types';
import type { SocialAccount, SocialObject, SocialComment, SocialPlatform, SocialObjectType } from '@prisma/client';

// ============================================================================
// Types
// ============================================================================

interface SyncStats {
  commentsProcessed: number;
  newComments: number;
  updatedComments: number;
  postsProcessed: number;
  errors: string[];
}

// ============================================================================
// Comment Processing
// ============================================================================

async function processComment(
  comment: MetaComment,
  account: SocialAccount,
  object: SocialObject,
  platform: SocialPlatform,
  parentId?: string
): Promise<{ isNew: boolean; commentId: string }> {
  const externalId = comment.id;

  // Check if comment already exists
  const existing = await prisma.socialComment.findUnique({
    where: {
      platform_externalId: {
        platform,
        externalId,
      },
    },
  });

  // Debug: Log the from field to see what Meta is returning
  if (!comment.from?.name) {
    console.log(`[Sync] Comment ${comment.id} missing 'from' data:`, JSON.stringify({
      from: comment.from,
      username: comment.username,
      hasFrom: !!comment.from,
      keys: comment.from ? Object.keys(comment.from) : [],
    }));
  }

  const authorId = comment.from?.id || null;
  const authorName = comment.from?.name || comment.username || 'Unknown';
  // Handle both picture formats: {url: "..."} and {data: {url: "..."}}
  const authorProfileUrl = comment.from?.picture?.url || comment.from?.picture?.data?.url || null;
  const commentedAt = new Date(comment.created_time || comment.timestamp || Date.now());

  const commentData = {
    accountId: account.id,
    objectId: object.id,
    platform,
    parentId: parentId || null,
    threadRootId: parentId ? (existing?.threadRootId || parentId) : null,
    authorId,
    authorName,
    authorUsername: comment.username || null,
    authorProfileUrl,
    isPageOwner: authorId === account.externalId,
    message: comment.message || '',
    attachmentUrl: comment.attachment?.url || comment.attachment?.media?.image?.src || null,
    permalink: comment.permalink_url || null,
    hidden: comment.is_hidden || false,
    canHide: comment.can_hide !== false,
    canDelete: comment.can_remove || false,
    canReply: true,
    canLike: platform === 'FACEBOOK',
    likeCount: comment.like_count || 0,
    replyCount: comment.comment_count || 0,
    commentedAt,
    rawPayload: comment as unknown as object,
  };

  // Use upsert to avoid race conditions when same comment appears in posts and ads
  const result = await prisma.socialComment.upsert({
    where: {
      platform_externalId: {
        platform,
        externalId,
      },
    },
    create: {
      externalId,
      ...commentData,
    },
    update: commentData,
  });

  const isNew = !existing;

  // Process rules for new comments
  if (isNew) {
    try {
      await processCommentRules(result.id, 'COMMENT_CREATED');
    } catch (err) {
      console.error('Error processing rules for comment:', err);
    }
  }

  return { isNew, commentId: result.id };
}

// ============================================================================
// Post/Object Processing
// ============================================================================

async function processPost(
  post: MetaPost,
  account: SocialAccount,
  platform: SocialPlatform,
  adInfo?: MetaAd | null
): Promise<SocialObject> {
  const externalId = post.id;
  const objectType: SocialObjectType = adInfo ? 'AD' : 'POST';

  // Check if object already exists
  const existing = await prisma.socialObject.findUnique({
    where: {
      accountId_externalId: {
        accountId: account.id,
        externalId,
      },
    },
  });

  const objectData = {
    accountId: account.id,
    type: objectType,
    permalink: post.permalink_url || null,
    message: post.message || post.story || null,
    thumbnailUrl: post.picture || null,
    mediaType: post.type || null,
    adId: adInfo?.id || null,
    adName: adInfo?.name || null,
    adsetId: adInfo?.adset_id || null,
    adsetName: adInfo?.adset?.name || null,
    campaignId: adInfo?.adset?.campaign_id || null,
    campaignName: adInfo?.adset?.campaign?.name || null,
    destinationUrl: adInfo?.creative?.object_story_spec?.link_data?.link ||
      adInfo?.creative?.object_story_spec?.link_data?.call_to_action?.value?.link || null,
    publishedAt: new Date(post.created_time),
  };

  if (existing) {
    return prisma.socialObject.update({
      where: { id: existing.id },
      data: objectData,
    });
  } else {
    return prisma.socialObject.create({
      data: {
        externalId,
        ...objectData,
      },
    });
  }
}

async function processInstagramMedia(
  media: {
    id: string;
    media_type: string;
    media_url?: string;
    thumbnail_url?: string;
    permalink: string;
    caption?: string;
    timestamp: string;
  },
  account: SocialAccount
): Promise<SocialObject> {
  const externalId = media.id;

  const existing = await prisma.socialObject.findUnique({
    where: {
      accountId_externalId: {
        accountId: account.id,
        externalId,
      },
    },
  });

  // Determine type based on media_type
  let objectType: SocialObjectType = 'POST';
  if (media.media_type === 'REELS') {
    objectType = 'REEL';
  }

  const objectData = {
    accountId: account.id,
    type: objectType,
    permalink: media.permalink,
    message: media.caption || null,
    thumbnailUrl: media.thumbnail_url || media.media_url || null,
    mediaType: media.media_type,
    publishedAt: new Date(media.timestamp),
  };

  if (existing) {
    return prisma.socialObject.update({
      where: { id: existing.id },
      data: objectData,
    });
  } else {
    return prisma.socialObject.create({
      data: {
        externalId,
        ...objectData,
      },
    });
  }
}

// ============================================================================
// Main Sync Functions
// ============================================================================

/**
 * Sync comments for a Facebook page
 */
export async function syncFacebookPage(
  account: SocialAccount,
  client: MetaClient,
  maxPosts = 25
): Promise<SyncStats> {
  const stats: SyncStats = {
    commentsProcessed: 0,
    newComments: 0,
    updatedComments: 0,
    postsProcessed: 0,
    errors: [],
  };

  try {
    // Get recent posts
    console.log(`[Sync] Fetching posts for page ${account.externalId}...`);
    const postsResponse = await client.getPagePosts(account.externalId, maxPosts);
    const posts = postsResponse.data || [];
    console.log(`[Sync] Found ${posts.length} posts`);

    for (const post of posts) {
      try {
        // Process the post
        const socialObject = await processPost(post, account, 'FACEBOOK');
        stats.postsProcessed++;

        // Get comments for this post
        let cursor: string | undefined;
        let hasMore = true;

        while (hasMore) {
          const commentsResponse = await client.getPostComments(post.id, 50, cursor);
          const comments = commentsResponse.data || [];

          for (const comment of comments) {
            try {
              const result = await processComment(comment, account, socialObject, 'FACEBOOK');
              stats.commentsProcessed++;
              if (result.isNew) {
                stats.newComments++;
              } else {
                stats.updatedComments++;
              }

              // Also fetch replies (nested comments)
              if (comment.comment_count && comment.comment_count > 0) {
                try {
                  const repliesResponse = await client.getPostComments(comment.id, 50);
                  for (const reply of repliesResponse.data || []) {
                    const replyResult = await processComment(
                      reply,
                      account,
                      socialObject,
                      'FACEBOOK',
                      result.commentId
                    );
                    stats.commentsProcessed++;
                    if (replyResult.isNew) {
                      stats.newComments++;
                    } else {
                      stats.updatedComments++;
                    }
                  }
                } catch (err) {
                  const error = err instanceof Error ? err.message : 'Unknown error';
                  stats.errors.push(`Error fetching replies for comment ${comment.id}: ${error}`);
                }
              }
            } catch (err) {
              const error = err instanceof Error ? err.message : 'Unknown error';
              stats.errors.push(`Error processing comment ${comment.id}: ${error}`);
            }
          }

          // Check for more pages
          cursor = commentsResponse.paging?.cursors?.after;
          hasMore = !!cursor && comments.length === 50;
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Unknown error';
        stats.errors.push(`Error processing post ${post.id}: ${error}`);
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    stats.errors.push(`Error syncing Facebook page: ${error}`);
  }

  return stats;
}

/**
 * Sync comments from Facebook Ads
 */
export async function syncFacebookAdComments(
  account: SocialAccount,
  client: MetaClient,
  adAccountId: string
): Promise<SyncStats> {
  const stats: SyncStats = {
    commentsProcessed: 0,
    newComments: 0,
    updatedComments: 0,
    postsProcessed: 0,
    errors: [],
  };

  try {
    console.log(`[Sync] Fetching ads for ad account ${adAccountId}...`);
    const ads = await client.getAdAccountAds(adAccountId, 100);
    console.log(`[Sync] Found ${ads.length} ads with story IDs`);

    // Group by unique story IDs to avoid fetching same post twice
    const storyMap = new Map<string, typeof ads[0]>();
    for (const ad of ads) {
      if (!storyMap.has(ad.storyId)) {
        storyMap.set(ad.storyId, ad);
      }
    }

    console.log(`[Sync] Processing ${storyMap.size} unique ad posts...`);

    for (const [storyId, ad] of storyMap) {
      try {
        // Fetch the actual post content for the ad
        let postMessage: string | null = null;
        let postPicture: string | null = null;
        let postPermalink: string | null = null;
        let postMediaType: string | null = null;
        let postCreatedTime: Date | null = null;

        try {
          const post = await client.getPost(storyId);
          postMessage = post.message || post.story || null;
          postPicture = post.full_picture || post.picture || null;
          postPermalink = post.permalink_url || null;
          postMediaType = post.type || null;
          postCreatedTime = post.created_time ? new Date(post.created_time) : null;
        } catch (postErr) {
          console.log(`[Sync] Could not fetch post details for ad ${ad.id}:`, postErr instanceof Error ? postErr.message : postErr);
          // Continue with ad metadata only
        }

        // Create or update the ad object
        const existing = await prisma.socialObject.findFirst({
          where: {
            accountId: account.id,
            externalId: storyId,
          },
        });

        const objectData = {
          accountId: account.id,
          type: 'AD' as SocialObjectType,
          message: postMessage,
          thumbnailUrl: postPicture,
          permalink: postPermalink,
          mediaType: postMediaType,
          publishedAt: postCreatedTime,
          adId: ad.id,
          adName: ad.name,
          adsetId: ad.adsetId || null,
          adsetName: ad.adsetName || null,
          campaignId: ad.campaignId || null,
          campaignName: ad.campaignName || null,
        };

        let socialObject: SocialObject;
        if (existing) {
          socialObject = await prisma.socialObject.update({
            where: { id: existing.id },
            data: objectData,
          });
        } else {
          socialObject = await prisma.socialObject.create({
            data: {
              externalId: storyId,
              ...objectData,
            },
          });
        }
        stats.postsProcessed++;

        // Get comments for this ad post
        let cursor: string | undefined;
        let hasMore = true;

        while (hasMore) {
          const commentsResponse = await client.getPostComments(storyId, 50, cursor);
          const comments = commentsResponse.data || [];

          for (const comment of comments) {
            try {
              const result = await processComment(comment, account, socialObject, 'FACEBOOK');
              stats.commentsProcessed++;
              if (result.isNew) {
                stats.newComments++;
              } else {
                stats.updatedComments++;
              }

              // Also fetch replies
              if (comment.comment_count && comment.comment_count > 0) {
                try {
                  const repliesResponse = await client.getPostComments(comment.id, 50);
                  for (const reply of repliesResponse.data || []) {
                    const replyResult = await processComment(
                      reply,
                      account,
                      socialObject,
                      'FACEBOOK',
                      result.commentId
                    );
                    stats.commentsProcessed++;
                    if (replyResult.isNew) {
                      stats.newComments++;
                    } else {
                      stats.updatedComments++;
                    }
                  }
                } catch (err) {
                  const error = err instanceof Error ? err.message : 'Unknown error';
                  stats.errors.push(`Error fetching replies: ${error}`);
                }
              }
            } catch (err) {
              const error = err instanceof Error ? err.message : 'Unknown error';
              stats.errors.push(`Error processing ad comment: ${error}`);
            }
          }

          cursor = commentsResponse.paging?.cursors?.after;
          hasMore = !!cursor && comments.length === 50;
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Unknown error';
        stats.errors.push(`Error processing ad ${ad.id}: ${error}`);
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    stats.errors.push(`Error syncing ad comments: ${error}`);
  }

  return stats;
}

/**
 * Sync comments for an Instagram account
 */
export async function syncInstagramAccount(
  account: SocialAccount,
  client: MetaClient,
  maxMedia = 25
): Promise<SyncStats> {
  const stats: SyncStats = {
    commentsProcessed: 0,
    newComments: 0,
    updatedComments: 0,
    postsProcessed: 0,
    errors: [],
  };

  try {
    // Get recent media
    const mediaResponse = await client.getInstagramMedia(account.externalId, maxMedia);
    const mediaItems = mediaResponse.data || [];

    for (const media of mediaItems) {
      try {
        // Process the media as a social object
        const socialObject = await processInstagramMedia(media, account);
        stats.postsProcessed++;

        // Get comments for this media
        let cursor: string | undefined;
        let hasMore = true;

        while (hasMore) {
          const commentsResponse = await client.getInstagramMediaComments(media.id, 50, cursor);
          const comments = commentsResponse.data || [];

          for (const comment of comments) {
            try {
              const result = await processComment(comment, account, socialObject, 'INSTAGRAM');
              stats.commentsProcessed++;
              if (result.isNew) {
                stats.newComments++;
              } else {
                stats.updatedComments++;
              }
            } catch (err) {
              const error = err instanceof Error ? err.message : 'Unknown error';
              stats.errors.push(`Error processing IG comment ${comment.id}: ${error}`);
            }
          }

          // Check for more pages
          cursor = commentsResponse.paging?.cursors?.after;
          hasMore = !!cursor && comments.length === 50;
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Unknown error';
        stats.errors.push(`Error processing media ${media.id}: ${error}`);
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    stats.errors.push(`Error syncing Instagram account: ${error}`);
  }

  return stats;
}

/**
 * Sync a single social account
 */
export async function syncSocialAccount(accountId: string): Promise<SyncStats> {
  const account = await prisma.socialAccount.findUnique({
    where: { id: accountId },
  });

  if (!account || !account.enabled) {
    return {
      commentsProcessed: 0,
      newComments: 0,
      updatedComments: 0,
      postsProcessed: 0,
      errors: ['Account not found or disabled'],
    };
  }

  // Create sync job
  const syncJob = await prisma.socialSyncJob.create({
    data: {
      accountId,
      status: 'RUNNING',
      startedAt: new Date(),
    },
  });

  let stats: SyncStats;

  try {
    console.log(`[Sync] Starting sync for account ${account.id} (${account.name}), platform: ${account.platform}, externalId: ${account.externalId}`);

    // Refresh page token to ensure we have current permissions
    const client = await createMetaClient(account.externalId, true);
    if (!client) {
      throw new Error('Meta client not configured');
    }
    console.log(`[Sync] Meta client created successfully (with refreshed page token)`);

    if (account.platform === 'FACEBOOK') {
      // Sync regular page posts
      stats = await syncFacebookPage(account, client);
      console.log(`[Sync] Facebook page sync complete:`, stats);

      // Also sync ad comments if ad account is configured
      const adAccountId = process.env.FACEBOOK_AD_ACCOUNT_IDS;
      if (adAccountId) {
        console.log(`[Sync] Syncing ad comments for ad account ${adAccountId}...`);
        const adStats = await syncFacebookAdComments(account, client, adAccountId);
        console.log(`[Sync] Ad comments sync complete:`, adStats);

        // Merge stats
        stats.commentsProcessed += adStats.commentsProcessed;
        stats.newComments += adStats.newComments;
        stats.updatedComments += adStats.updatedComments;
        stats.postsProcessed += adStats.postsProcessed;
        stats.errors.push(...adStats.errors);
      }
    } else {
      stats = await syncInstagramAccount(account, client);
      console.log(`[Sync] Instagram sync complete:`, stats);
    }

    // Update account sync time
    await prisma.socialAccount.update({
      where: { id: accountId },
      data: {
        lastSyncAt: new Date(),
        syncError: stats.errors.length > 0 ? stats.errors.join('; ') : null,
      },
    });

    // Update sync job
    await prisma.socialSyncJob.update({
      where: { id: syncJob.id },
      data: {
        status: stats.errors.length > 0 ? 'FAILED' : 'COMPLETED',
        completedAt: new Date(),
        commentsProcessed: stats.commentsProcessed,
        newComments: stats.newComments,
        errorMessage: stats.errors.length > 0 ? stats.errors.join('; ') : null,
      },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';

    await prisma.socialAccount.update({
      where: { id: accountId },
      data: { syncError: error },
    });

    await prisma.socialSyncJob.update({
      where: { id: syncJob.id },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage: error,
      },
    });

    stats = {
      commentsProcessed: 0,
      newComments: 0,
      updatedComments: 0,
      postsProcessed: 0,
      errors: [error],
    };
  }

  return stats;
}

/**
 * Sync all enabled social accounts
 */
export async function syncAllSocialAccounts(): Promise<Map<string, SyncStats>> {
  const accounts = await prisma.socialAccount.findMany({
    where: { enabled: true },
  });

  const results = new Map<string, SyncStats>();

  for (const account of accounts) {
    const stats = await syncSocialAccount(account.id);
    results.set(account.id, stats);
  }

  return results;
}

// ============================================================================
// Webhook Processing
// ============================================================================

/**
 * Process a Meta webhook event
 */
export async function processWebhookEvent(
  entry: {
    id: string;
    time: number;
    changes?: Array<{
      field: string;
      value: {
        item: string;
        verb: string;
        comment_id?: string;
        post_id?: string;
        parent_id?: string;
        from?: { id: string; name: string };
        message?: string;
        created_time?: number;
        is_hidden?: boolean;
      };
    }>;
  }
): Promise<void> {
  const pageId = entry.id;

  // Find the account for this page
  const account = await prisma.socialAccount.findFirst({
    where: {
      platform: 'FACEBOOK',
      externalId: pageId,
      enabled: true,
      webhookEnabled: true,
    },
  });

  if (!account) {
    console.log(`No webhook-enabled account found for page ${pageId}`);
    return;
  }

  for (const change of entry.changes || []) {
    if (change.field !== 'feed' || change.value.item !== 'comment') {
      continue;
    }

    const { verb, comment_id, post_id, parent_id, from, message, created_time, is_hidden } = change.value;

    if (!comment_id || !post_id) {
      continue;
    }

    // Handle different verbs
    if (verb === 'add' || verb === 'edited') {
      // Get the full comment details from API
      try {
        const client = await createMetaClient(account.externalId);
        if (!client) {
          console.error('Meta client not configured');
          continue;
        }

        const comment = await client.getComment(comment_id);

        // Get or create the post object
        let socialObject = await prisma.socialObject.findFirst({
          where: {
            accountId: account.id,
            externalId: post_id,
          },
        });

        if (!socialObject) {
          const post = await client.getPost(post_id);
          socialObject = await processPost(post, account, 'FACEBOOK');
        }

        // Process the comment
        const result = await processComment(comment, account, socialObject, 'FACEBOOK', parent_id || undefined);

        // If it's a new comment, rules were already processed in processComment
        // If it's an edit, process rules with COMMENT_UPDATED trigger
        if (!result.isNew && verb === 'edited') {
          await processCommentRules(result.commentId, 'COMMENT_UPDATED');
        }
      } catch (err) {
        console.error(`Error processing webhook comment ${comment_id}:`, err);
      }
    } else if (verb === 'remove') {
      // Mark comment as deleted
      await prisma.socialComment.updateMany({
        where: {
          platform: 'FACEBOOK',
          externalId: comment_id,
        },
        data: { deleted: true },
      });
    }
  }
}
