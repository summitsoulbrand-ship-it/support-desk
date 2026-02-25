/**
 * Social Comments - TypeScript types and interfaces
 */

import type {
  SocialPlatform,
  SocialAccountType,
  SocialCommentStatus,
  SocialObjectType,
  SocialRuleTrigger,
  SocialActionType,
} from '@prisma/client';

// Re-export Prisma enums
export {
  SocialPlatform,
  SocialAccountType,
  SocialCommentStatus,
  SocialObjectType,
  SocialRuleTrigger,
  SocialActionType,
};

// SocialRuleAction is defined in Prisma schema but not used in any model field,
// so Prisma doesn't export it. Define it locally.
export type SocialRuleAction =
  | 'HIDE_COMMENT'
  | 'UNHIDE_COMMENT'
  | 'DELETE_COMMENT'
  | 'LIKE_COMMENT'
  | 'ADD_LABEL'
  | 'SET_STATUS'
  | 'ASSIGN_TO_AGENT'
  | 'NOTIFY';

// ============================================================================
// Meta API Types
// ============================================================================

export interface MetaTokens {
  accessToken: string;
  tokenType: string;
  expiresAt?: Date;
  refreshToken?: string;
  scopes?: string[];
}

export interface MetaUserInfo {
  id: string;
  name: string;
  email?: string;
}

export interface MetaPage {
  id: string;
  name: string;
  accessToken: string; // Page-specific token
  category?: string;
  pictureUrl?: string;
  instagramBusinessAccount?: {
    id: string;
    username: string;
    name: string;
    profilePictureUrl?: string;
  };
}

export interface MetaComment {
  id: string;
  message: string;
  from?: {
    id: string;
    name: string;
    picture?: {
      // Can be either {url: "..."} or {data: {url: "..."}} depending on request format
      url?: string;
      data?: {
        url: string;
      };
    };
  };
  created_time: string;
  permalink_url?: string;
  is_hidden?: boolean;
  can_hide?: boolean;
  can_remove?: boolean;
  can_reply_privately?: boolean;
  like_count?: number;
  comment_count?: number;
  attachment?: {
    type: string;
    url?: string;
    media?: {
      image?: {
        src: string;
      };
    };
  };
  parent?: {
    id: string;
  };
  // For Instagram
  username?: string;
  timestamp?: string;
}

export interface MetaPost {
  id: string;
  message?: string;
  story?: string;
  picture?: string;
  full_picture?: string; // Higher resolution version
  permalink_url?: string;
  created_time: string;
  is_published?: boolean;
  type?: string; // Post type (photo, video, link, etc.)
  // Ad info (if available)
  promoted_object?: {
    ad_id?: string;
  };
}

export interface MetaAd {
  id: string;
  name: string;
  adset_id: string;
  adset?: {
    id: string;
    name: string;
    campaign_id: string;
    campaign?: {
      id: string;
      name: string;
    };
  };
  creative?: {
    id: string;
    name?: string;
    thumbnail_url?: string;
    effective_object_story_id?: string;
    object_story_spec?: {
      link_data?: {
        link?: string;
        call_to_action?: {
          value?: {
            link?: string;
          };
        };
      };
    };
  };
  status: string;
}

export interface MetaWebhookEntry {
  id: string;
  time: number;
  changes?: MetaWebhookChange[];
  messaging?: unknown[];
}

export interface MetaWebhookChange {
  field: string;
  value: {
    item: 'comment' | 'post' | 'reaction' | 'share';
    verb: 'add' | 'edited' | 'remove';
    comment_id?: string;
    post_id?: string;
    parent_id?: string;
    from?: {
      id: string;
      name: string;
    };
    message?: string;
    created_time?: number;
    is_hidden?: boolean;
  };
}

// ============================================================================
// Rule Engine Types
// ============================================================================

export type RuleMatchType = 'all' | 'any';

export type RuleConditionType =
  | 'keyword'
  | 'keyword_list'
  | 'regex'
  | 'has_url'
  | 'has_mention'
  | 'is_reply'
  | 'is_top_level'
  | 'comment_length_min'
  | 'comment_length_max'
  | 'author_is_page'
  | 'language';

export interface RuleCondition {
  type: RuleConditionType;
  value: string | number | string[];
  negated?: boolean;
  caseSensitive?: boolean;
}

export interface RuleConditions {
  matchType: RuleMatchType;
  conditions: RuleCondition[];
}

export interface RuleActionParams {
  label?: string; // For ADD_LABEL
  status?: SocialCommentStatus; // For SET_STATUS
  userId?: string; // For ASSIGN_TO_AGENT
  message?: string; // For notifications
}

export interface RuleActionDefinition {
  type: SocialRuleAction;
  params?: RuleActionParams;
}

export interface RuleMatchResult {
  matched: boolean;
  matchedConditions: RuleCondition[];
  failedConditions: RuleCondition[];
}

export interface RuleExecutionResult {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  matchResult?: RuleMatchResult;
  actionsExecuted: {
    action: RuleActionDefinition;
    success: boolean;
    error?: string;
  }[];
  wasDryRun: boolean;
  wasFlagged: boolean;
  stoppedProcessing: boolean;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface SocialAccountResponse {
  id: string;
  platform: SocialPlatform;
  accountType: SocialAccountType;
  externalId: string;
  name: string;
  username?: string | null;
  profilePictureUrl?: string | null;
  webhookEnabled: boolean;
  enabled: boolean;
  lastSyncAt?: Date | null;
  syncError?: string | null;
}

export interface SocialCommentResponse {
  id: string;
  platform: SocialPlatform;
  externalId: string;
  authorName: string;
  authorUsername?: string | null;
  authorProfileUrl?: string | null;
  message: string;
  hidden: boolean;
  deleted: boolean;
  status: SocialCommentStatus;
  likeCount: number;
  replyCount: number;
  isLikedByPage: boolean;
  internalLabel?: string | null;
  commentedAt: Date;
  canHide: boolean;
  canDelete: boolean;
  canReply: boolean;
  canLike: boolean;
  permalink?: string | null;
  // Relations
  account: {
    id: string;
    name: string;
    platform: SocialPlatform;
  };
  object: {
    id: string;
    type: SocialObjectType;
    message?: string | null;
    thumbnailUrl?: string | null;
    permalink?: string | null;
    adId?: string | null;
    adName?: string | null;
    campaignName?: string | null;
  };
  parent?: {
    id: string;
    authorName: string;
    message: string;
  } | null;
  replies?: SocialCommentResponse[];
}

export interface SocialObjectResponse {
  id: string;
  type: SocialObjectType;
  externalId: string;
  permalink?: string | null;
  message?: string | null;
  thumbnailUrl?: string | null;
  mediaType?: string | null;
  // Ad context
  adId?: string | null;
  adName?: string | null;
  adsetId?: string | null;
  adsetName?: string | null;
  campaignId?: string | null;
  campaignName?: string | null;
  destinationUrl?: string | null;
  publishedAt?: Date | null;
}

export interface SocialRuleResponse {
  id: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  priority: number;
  platforms: SocialPlatform[];
  triggers: SocialRuleTrigger[];
  conditions: RuleConditions;
  actions: RuleActionDefinition[];
  dryRun: boolean;
  requireReview: boolean;
  stopOnMatch: boolean;
  maxActionsPerHour?: number | null;
  matchCount: number;
  actionCount: number;
  lastMatchAt?: Date | null;
  accounts: { id: string; name: string }[];
}

// ============================================================================
// Filter/Query Types
// ============================================================================

export interface SocialCommentFilter {
  platforms?: SocialPlatform[];
  accountIds?: string[];
  status?: SocialCommentStatus[];
  hidden?: boolean;
  hasReply?: boolean;
  isAd?: boolean;
  labels?: string[];
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

export interface SocialCommentListParams extends SocialCommentFilter {
  page?: number;
  limit?: number;
  sortBy?: 'commentedAt' | 'updatedAt' | 'likeCount';
  sortOrder?: 'asc' | 'desc';
}

// ============================================================================
// Action Types
// ============================================================================

export interface CommentActionResult {
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface ReplyToCommentInput {
  commentId: string;
  message: string;
  attachmentUrl?: string;
}

export interface UpdateCommentStatusInput {
  commentId: string;
  status: SocialCommentStatus;
}
