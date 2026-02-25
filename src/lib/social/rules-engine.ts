/**
 * Social Comments Automation Rules Engine
 * Evaluates comments against rules and executes actions
 */

import prisma from '@/lib/db';
import { MetaClient, createMetaClient } from './meta-client';
import {
  SocialPlatform,
  SocialRuleAction,
  SocialActionType,
  RuleConditions,
  RuleCondition,
  RuleActionDefinition,
  RuleMatchResult,
  RuleExecutionResult,
  SocialCommentStatus,
} from './types';
import type { SocialComment, SocialRule, SocialAccount, SocialActionType as PrismaActionType } from '@prisma/client';

// Map rule action types to log action types
function mapRuleActionToLogAction(ruleAction: SocialRuleAction): PrismaActionType {
  const mapping: Record<SocialRuleAction, PrismaActionType> = {
    'HIDE_COMMENT': 'HIDE',
    'UNHIDE_COMMENT': 'UNHIDE',
    'DELETE_COMMENT': 'DELETE',
    'LIKE_COMMENT': 'LIKE',
    'ADD_LABEL': 'LABEL_ADDED',
    'SET_STATUS': 'STATUS_CHANGED',
    'ASSIGN_TO_AGENT': 'ASSIGNED',
    'NOTIFY': 'NOTE_ADDED', // Use NOTE_ADDED as closest match
  };
  return mapping[ruleAction];
}

// ============================================================================
// Condition Evaluators
// ============================================================================

function evaluateCondition(
  condition: RuleCondition,
  comment: SocialComment
): boolean {
  const message = comment.message || '';
  let result: boolean;

  switch (condition.type) {
    case 'keyword': {
      const keyword = String(condition.value);
      const searchText = condition.caseSensitive ? message : message.toLowerCase();
      const searchKeyword = condition.caseSensitive ? keyword : keyword.toLowerCase();
      result = searchText.includes(searchKeyword);
      break;
    }

    case 'keyword_list': {
      const keywords = Array.isArray(condition.value) ? condition.value : [];
      const searchText = condition.caseSensitive ? message : message.toLowerCase();
      result = keywords.some((kw) => {
        const keyword = condition.caseSensitive ? kw : kw.toLowerCase();
        return searchText.includes(keyword);
      });
      break;
    }

    case 'regex': {
      try {
        const flags = condition.caseSensitive ? '' : 'i';
        const regex = new RegExp(String(condition.value), flags);
        result = regex.test(message);
      } catch {
        console.error(`Invalid regex in rule condition: ${condition.value}`);
        result = false;
      }
      break;
    }

    case 'has_url': {
      const urlPattern = /https?:\/\/[^\s]+/i;
      result = urlPattern.test(message);
      break;
    }

    case 'has_mention': {
      const mentionPattern = /@[\w.]+/;
      result = mentionPattern.test(message);
      break;
    }

    case 'is_reply': {
      result = comment.parentId !== null;
      break;
    }

    case 'is_top_level': {
      result = comment.parentId === null;
      break;
    }

    case 'comment_length_min': {
      const minLength = Number(condition.value) || 0;
      result = message.length >= minLength;
      break;
    }

    case 'comment_length_max': {
      const maxLength = Number(condition.value) || Infinity;
      result = message.length <= maxLength;
      break;
    }

    case 'author_is_page': {
      result = comment.isPageOwner === true;
      break;
    }

    case 'language': {
      // Simple language detection based on character ranges
      // For more accurate detection, integrate with a language detection service
      const langCode = String(condition.value).toLowerCase();
      // This is a placeholder - in production, use a proper language detection library
      result = langCode === 'en'; // Default to true for English
      break;
    }

    default:
      result = false;
  }

  // Apply negation if specified
  return condition.negated ? !result : result;
}

function evaluateConditions(
  conditions: RuleConditions,
  comment: SocialComment
): RuleMatchResult {
  const matchedConditions: RuleCondition[] = [];
  const failedConditions: RuleCondition[] = [];

  for (const condition of conditions.conditions) {
    const conditionResult = evaluateCondition(condition, comment);
    if (conditionResult) {
      matchedConditions.push(condition);
    } else {
      failedConditions.push(condition);
    }
  }

  const matched =
    conditions.matchType === 'all'
      ? failedConditions.length === 0 && matchedConditions.length > 0
      : matchedConditions.length > 0;

  return { matched, matchedConditions, failedConditions };
}

// ============================================================================
// Action Executors
// ============================================================================

async function executeAction(
  action: RuleActionDefinition,
  comment: SocialComment,
  account: SocialAccount,
  dryRun: boolean
): Promise<{ success: boolean; error?: string }> {
  // Don't execute in dry run mode
  if (dryRun) {
    console.log(`[DRY RUN] Would execute ${action.type} on comment ${comment.id}`);
    return { success: true };
  }

  try {
    switch (action.type) {
      case 'HIDE_COMMENT': {
        if (comment.platform !== 'FACEBOOK') {
          return { success: false, error: 'Hide is only supported on Facebook' };
        }
        if (!comment.canHide) {
          return { success: false, error: 'Cannot hide this comment (permission denied)' };
        }
        const client = await createMetaClient(account.externalId);
        if (!client) {
          return { success: false, error: 'Meta client not configured' };
        }
        const result = await client.hideComment(comment.externalId);
        if (result.success) {
          await prisma.socialComment.update({
            where: { id: comment.id },
            data: { hidden: true },
          });
        }
        return result;
      }

      case 'UNHIDE_COMMENT': {
        if (comment.platform !== 'FACEBOOK') {
          return { success: false, error: 'Unhide is only supported on Facebook' };
        }
        const client = await createMetaClient(account.externalId);
        if (!client) {
          return { success: false, error: 'Meta client not configured' };
        }
        const result = await client.unhideComment(comment.externalId);
        if (result.success) {
          await prisma.socialComment.update({
            where: { id: comment.id },
            data: { hidden: false },
          });
        }
        return result;
      }

      case 'DELETE_COMMENT': {
        if (!comment.canDelete) {
          return { success: false, error: 'Cannot delete this comment (permission denied)' };
        }
        const client = await createMetaClient(account.externalId);
        if (!client) {
          return { success: false, error: 'Meta client not configured' };
        }
        const result = comment.platform === 'INSTAGRAM'
          ? await client.deleteInstagramComment(comment.externalId)
          : await client.deleteComment(comment.externalId);
        if (result.success) {
          await prisma.socialComment.update({
            where: { id: comment.id },
            data: { deleted: true },
          });
        }
        return result;
      }

      case 'LIKE_COMMENT': {
        if (!comment.canLike || comment.platform !== 'FACEBOOK') {
          return { success: false, error: 'Cannot like this comment' };
        }
        const client = await createMetaClient(account.externalId);
        if (!client) {
          return { success: false, error: 'Meta client not configured' };
        }
        const result = await client.likeComment(comment.externalId);
        if (result.success) {
          await prisma.socialComment.update({
            where: { id: comment.id },
            data: { isLikedByPage: true },
          });
        }
        return result;
      }

      case 'ADD_LABEL': {
        const label = action.params?.label || 'flagged';
        await prisma.socialComment.update({
          where: { id: comment.id },
          data: { internalLabel: label },
        });
        return { success: true };
      }

      case 'SET_STATUS': {
        const status = action.params?.status || 'ESCALATED';
        await prisma.socialComment.update({
          where: { id: comment.id },
          data: { status: status as SocialCommentStatus },
        });
        return { success: true };
      }

      case 'ASSIGN_TO_AGENT': {
        const userId = action.params?.userId;
        if (!userId) {
          return { success: false, error: 'No user ID specified for assignment' };
        }
        await prisma.socialComment.update({
          where: { id: comment.id },
          data: { assignedUserId: userId },
        });
        return { success: true };
      }

      case 'NOTIFY': {
        // For now, just log the notification
        // In production, integrate with a notification system
        console.log(`[NOTIFICATION] Rule matched for comment ${comment.id}: ${action.params?.message || 'Comment requires attention'}`);
        return { success: true };
      }

      default:
        return { success: false, error: `Unknown action type: ${action.type}` };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    console.error(`Error executing action ${action.type}:`, error);
    return { success: false, error };
  }
}

// ============================================================================
// Rate Limiting
// ============================================================================

async function checkRateLimit(rule: SocialRule): Promise<boolean> {
  if (!rule.maxActionsPerHour) {
    return true; // No rate limit
  }

  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  // Reset counter if an hour has passed
  if (!rule.lastHourReset || rule.lastHourReset < hourAgo) {
    await prisma.socialRule.update({
      where: { id: rule.id },
      data: {
        actionsThisHour: 0,
        lastHourReset: now,
      },
    });
    return true;
  }

  // Check if we've exceeded the limit
  if (rule.actionsThisHour >= rule.maxActionsPerHour) {
    console.log(`Rate limit exceeded for rule ${rule.id}: ${rule.actionsThisHour}/${rule.maxActionsPerHour} actions this hour`);
    return false;
  }

  return true;
}

async function incrementActionCount(ruleId: string): Promise<void> {
  await prisma.socialRule.update({
    where: { id: ruleId },
    data: {
      actionsThisHour: { increment: 1 },
      actionCount: { increment: 1 },
    },
  });
}

// ============================================================================
// Main Rule Evaluation
// ============================================================================

/**
 * Evaluate a single rule against a comment
 */
export async function evaluateRule(
  rule: SocialRule & { accounts: SocialAccount[] },
  comment: SocialComment,
  account: SocialAccount
): Promise<RuleExecutionResult> {
  const conditions = rule.conditions as unknown as RuleConditions;
  const actions = rule.actions as unknown as RuleActionDefinition[];
  const triggers = rule.triggers as string[];

  // Check if rule applies to this platform
  const platforms = rule.platforms as SocialPlatform[];
  if (!platforms.includes(comment.platform)) {
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      matched: false,
      actionsExecuted: [],
      wasDryRun: rule.dryRun,
      wasFlagged: false,
      stoppedProcessing: false,
    };
  }

  // Check if rule applies to this account
  if (rule.accounts.length > 0) {
    const accountIds = rule.accounts.map((a) => a.id);
    if (!accountIds.includes(account.id)) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        matched: false,
        actionsExecuted: [],
        wasDryRun: rule.dryRun,
        wasFlagged: false,
        stoppedProcessing: false,
      };
    }
  }

  // Evaluate conditions
  const matchResult = evaluateConditions(conditions, comment);

  if (!matchResult.matched) {
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      matched: false,
      matchResult,
      actionsExecuted: [],
      wasDryRun: rule.dryRun,
      wasFlagged: false,
      stoppedProcessing: false,
    };
  }

  // Rule matched - update stats
  await prisma.socialRule.update({
    where: { id: rule.id },
    data: {
      matchCount: { increment: 1 },
      lastMatchAt: new Date(),
    },
  });

  // Check rate limit
  const withinRateLimit = await checkRateLimit(rule);

  // If require review mode, flag instead of acting
  const wasFlagged = rule.requireReview;
  if (wasFlagged) {
    await prisma.socialComment.update({
      where: { id: comment.id },
      data: { internalLabel: 'needs_review' },
    });
  }

  // Execute actions
  const actionsExecuted: RuleExecutionResult['actionsExecuted'] = [];
  let stoppedProcessing = false;

  if (!rule.dryRun && !wasFlagged && withinRateLimit) {
    for (const action of actions) {
      const result = await executeAction(action, comment, account, false);
      actionsExecuted.push({ action, success: result.success, error: result.error });

      if (result.success) {
        await incrementActionCount(rule.id);
      }

      // Log the action
      await prisma.socialActionLog.create({
        data: {
          commentId: comment.id,
          actionType: mapRuleActionToLogAction(action.type),
          actorType: 'automation',
          actorId: rule.id,
          actorName: `Rule: ${rule.name}`,
          details: JSON.parse(JSON.stringify({ action, result })),
          apiSuccess: result.success,
          apiError: result.error,
        },
      });

      // If this is a destructive action (delete), stop processing
      if (action.type === 'DELETE_COMMENT' && result.success) {
        stoppedProcessing = true;
        break;
      }
    }
  } else if (rule.dryRun) {
    // Log dry run
    for (const action of actions) {
      actionsExecuted.push({ action, success: true });
    }
  }

  // Store the rule run
  await prisma.socialRuleRun.create({
    data: {
      ruleId: rule.id,
      commentId: comment.id,
      matched: true,
      matchDetails: JSON.parse(JSON.stringify(matchResult)),
      actionsExecuted: JSON.parse(JSON.stringify(actionsExecuted)),
      allSucceeded: actionsExecuted.every((a) => a.success),
      errors: actionsExecuted.filter((a) => a.error).map((a) => a.error).filter((e): e is string => !!e),
      wasDryRun: rule.dryRun,
      wasFlagged,
    },
  });

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    matched: true,
    matchResult,
    actionsExecuted,
    wasDryRun: rule.dryRun,
    wasFlagged,
    stoppedProcessing: stoppedProcessing || rule.stopOnMatch,
  };
}

/**
 * Process a comment through all applicable rules
 */
export async function processCommentRules(
  commentId: string,
  trigger: 'COMMENT_CREATED' | 'COMMENT_UPDATED' = 'COMMENT_CREATED'
): Promise<RuleExecutionResult[]> {
  // Get the comment with its account
  const comment = await prisma.socialComment.findUnique({
    where: { id: commentId },
    include: { account: true },
  });

  if (!comment || comment.deleted) {
    return [];
  }

  // Check for idempotency - don't re-process
  const existingRun = await prisma.socialRuleRun.findFirst({
    where: {
      commentId,
      matched: true,
      allSucceeded: true,
    },
  });

  if (existingRun) {
    console.log(`Comment ${commentId} already processed by rules, skipping`);
    return [];
  }

  // Get all enabled rules that match this trigger, ordered by priority
  const rules = await prisma.socialRule.findMany({
    where: {
      enabled: true,
      triggers: { has: trigger },
    },
    include: {
      accounts: true,
    },
    orderBy: { priority: 'asc' },
  });

  const results: RuleExecutionResult[] = [];

  for (const rule of rules) {
    const result = await evaluateRule(rule, comment, comment.account);
    results.push(result);

    // If rule matched and stopOnMatch is true, stop processing more rules
    if (result.matched && result.stoppedProcessing) {
      break;
    }
  }

  return results;
}

/**
 * Test a rule against a comment without executing actions
 */
export async function testRule(
  rule: {
    platforms: SocialPlatform[];
    conditions: RuleConditions;
    actions: RuleActionDefinition[];
  },
  commentId: string
): Promise<{
  matched: boolean;
  matchResult: RuleMatchResult;
  wouldExecute: RuleActionDefinition[];
}> {
  const comment = await prisma.socialComment.findUnique({
    where: { id: commentId },
  });

  if (!comment) {
    throw new Error('Comment not found');
  }

  if (!rule.platforms.includes(comment.platform)) {
    return {
      matched: false,
      matchResult: { matched: false, matchedConditions: [], failedConditions: [] },
      wouldExecute: [],
    };
  }

  const matchResult = evaluateConditions(rule.conditions, comment);

  return {
    matched: matchResult.matched,
    matchResult,
    wouldExecute: matchResult.matched ? rule.actions : [],
  };
}
