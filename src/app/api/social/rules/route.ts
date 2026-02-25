/**
 * Social Automation Rules API
 * CRUD operations for automation rules
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { z } from 'zod';
import type { SocialPlatform, SocialRuleTrigger } from '@prisma/client';
import type { SocialRuleAction } from '@/lib/social/types';

const ruleConditionSchema = z.object({
  type: z.enum([
    'keyword',
    'keyword_list',
    'regex',
    'has_url',
    'has_mention',
    'is_reply',
    'is_top_level',
    'comment_length_min',
    'comment_length_max',
    'author_is_page',
    'language',
  ]),
  value: z.union([z.string(), z.number(), z.array(z.string())]),
  negated: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
});

const ruleConditionsSchema = z.object({
  matchType: z.enum(['all', 'any']),
  conditions: z.array(ruleConditionSchema),
});

const ruleActionSchema = z.object({
  type: z.enum([
    'HIDE_COMMENT',
    'UNHIDE_COMMENT',
    'DELETE_COMMENT',
    'LIKE_COMMENT',
    'ADD_LABEL',
    'SET_STATUS',
    'ASSIGN_TO_AGENT',
    'NOTIFY',
  ]),
  params: z
    .object({
      label: z.string().optional(),
      status: z.enum(['NEW', 'IN_PROGRESS', 'DONE', 'ESCALATED']).optional(),
      userId: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
});

const createRuleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(1).max(1000).default(100),
  platforms: z.array(z.enum(['FACEBOOK', 'INSTAGRAM'])).min(1),
  accountIds: z.array(z.string()).optional(),
  triggers: z.array(z.enum(['COMMENT_CREATED', 'COMMENT_UPDATED'])).min(1),
  conditions: ruleConditionsSchema,
  actions: z.array(ruleActionSchema).min(1),
  dryRun: z.boolean().default(false),
  requireReview: z.boolean().default(false),
  stopOnMatch: z.boolean().default(true),
  maxActionsPerHour: z.number().int().min(1).nullable().optional(),
});

/**
 * GET - List all rules
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'MANAGE_SETTINGS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const rules = await prisma.socialRule.findMany({
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      include: {
        accounts: {
          select: {
            id: true,
            name: true,
            platform: true,
          },
        },
        _count: {
          select: {
            runs: true,
          },
        },
      },
    });

    const formattedRules = rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      enabled: rule.enabled,
      priority: rule.priority,
      platforms: rule.platforms,
      triggers: rule.triggers,
      conditions: rule.conditions,
      actions: rule.actions,
      dryRun: rule.dryRun,
      requireReview: rule.requireReview,
      stopOnMatch: rule.stopOnMatch,
      maxActionsPerHour: rule.maxActionsPerHour,
      matchCount: rule.matchCount,
      actionCount: rule.actionCount,
      lastMatchAt: rule.lastMatchAt,
      accounts: rule.accounts,
      runsCount: rule._count.runs,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    }));

    return NextResponse.json({ rules: formattedRules });
  } catch (err) {
    console.error('Error fetching social rules:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * POST - Create a new rule
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'MANAGE_SETTINGS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const data = createRuleSchema.parse(body);

    // Validate that accounts exist
    if (data.accountIds && data.accountIds.length > 0) {
      const accounts = await prisma.socialAccount.findMany({
        where: { id: { in: data.accountIds } },
        select: { id: true },
      });

      if (accounts.length !== data.accountIds.length) {
        return NextResponse.json(
          { error: 'One or more accounts not found' },
          { status: 400 }
        );
      }
    }

    const rule = await prisma.socialRule.create({
      data: {
        name: data.name,
        description: data.description,
        enabled: data.enabled,
        priority: data.priority,
        platforms: data.platforms as SocialPlatform[],
        triggers: data.triggers as SocialRuleTrigger[],
        conditions: data.conditions,
        actions: data.actions,
        dryRun: data.dryRun,
        requireReview: data.requireReview,
        stopOnMatch: data.stopOnMatch,
        maxActionsPerHour: data.maxActionsPerHour,
        createdBy: session.user.id,
        accounts: data.accountIds
          ? { connect: data.accountIds.map((id) => ({ id })) }
          : undefined,
      },
      include: {
        accounts: {
          select: {
            id: true,
            name: true,
            platform: true,
          },
        },
      },
    });

    return NextResponse.json({ success: true, rule });
  } catch (err) {
    console.error('Error creating social rule:', err);
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request', details: err.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
