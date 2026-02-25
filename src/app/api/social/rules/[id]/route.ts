/**
 * Single Social Rule API
 * Get, update, delete a rule
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { z } from 'zod';
import { testRule } from '@/lib/social/rules-engine';
import type { SocialPlatform, SocialRuleTrigger } from '@prisma/client';

type RouteContext = {
  params: Promise<{ id: string }>;
};

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

const updateRuleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(1).max(1000).optional(),
  platforms: z.array(z.enum(['FACEBOOK', 'INSTAGRAM'])).min(1).optional(),
  accountIds: z.array(z.string()).optional(),
  triggers: z.array(z.enum(['COMMENT_CREATED', 'COMMENT_UPDATED'])).min(1).optional(),
  conditions: ruleConditionsSchema.optional(),
  actions: z.array(ruleActionSchema).min(1).optional(),
  dryRun: z.boolean().optional(),
  requireReview: z.boolean().optional(),
  stopOnMatch: z.boolean().optional(),
  maxActionsPerHour: z.number().int().min(1).nullable().optional(),
});

/**
 * GET - Get a single rule with run history
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'MANAGE_SETTINGS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;

    const rule = await prisma.socialRule.findUnique({
      where: { id },
      include: {
        accounts: {
          select: {
            id: true,
            name: true,
            platform: true,
          },
        },
        runs: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: {
            comment: {
              select: {
                id: true,
                message: true,
                authorName: true,
                commentedAt: true,
              },
            },
          },
        },
      },
    });

    if (!rule) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    }

    return NextResponse.json({ rule });
  } catch (err) {
    console.error('Error fetching social rule:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * PATCH - Update a rule
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'MANAGE_SETTINGS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;
    const body = await request.json();
    const data = updateRuleSchema.parse(body);

    const existingRule = await prisma.socialRule.findUnique({
      where: { id },
    });

    if (!existingRule) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    }

    // Build update data
    const updateData: Parameters<typeof prisma.socialRule.update>[0]['data'] = {};

    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.enabled !== undefined) updateData.enabled = data.enabled;
    if (data.priority !== undefined) updateData.priority = data.priority;
    if (data.platforms !== undefined) updateData.platforms = data.platforms as SocialPlatform[];
    if (data.triggers !== undefined) updateData.triggers = data.triggers as SocialRuleTrigger[];
    if (data.conditions !== undefined) updateData.conditions = data.conditions;
    if (data.actions !== undefined) updateData.actions = data.actions;
    if (data.dryRun !== undefined) updateData.dryRun = data.dryRun;
    if (data.requireReview !== undefined) updateData.requireReview = data.requireReview;
    if (data.stopOnMatch !== undefined) updateData.stopOnMatch = data.stopOnMatch;
    if (data.maxActionsPerHour !== undefined) updateData.maxActionsPerHour = data.maxActionsPerHour;

    // Handle account connections
    if (data.accountIds !== undefined) {
      // Disconnect all existing accounts and connect new ones
      updateData.accounts = {
        set: data.accountIds.map((accountId) => ({ id: accountId })),
      };
    }

    const rule = await prisma.socialRule.update({
      where: { id },
      data: updateData,
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
    console.error('Error updating social rule:', err);
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

/**
 * DELETE - Delete a rule
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'MANAGE_SETTINGS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;

    const existingRule = await prisma.socialRule.findUnique({
      where: { id },
    });

    if (!existingRule) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    }

    await prisma.socialRule.delete({
      where: { id },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error deleting social rule:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * POST - Test a rule against a specific comment
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'MANAGE_SETTINGS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;
    const body = await request.json();
    const { commentId } = body;

    if (!commentId) {
      return NextResponse.json(
        { error: 'commentId is required' },
        { status: 400 }
      );
    }

    const rule = await prisma.socialRule.findUnique({
      where: { id },
    });

    if (!rule) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    }

    const result = await testRule(
      {
        platforms: rule.platforms as SocialPlatform[],
        conditions: rule.conditions as unknown as Parameters<typeof testRule>[0]['conditions'],
        actions: rule.actions as unknown as Parameters<typeof testRule>[0]['actions'],
      },
      commentId
    );

    return NextResponse.json({ result });
  } catch (err) {
    console.error('Error testing social rule:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
