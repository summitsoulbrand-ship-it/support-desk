/**
 * Single Social Comment API
 * Get comment details and perform actions
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { z } from 'zod';
import { createMetaClient } from '@/lib/social/meta-client';
import type { SocialCommentStatus, SocialActionType } from '@prisma/client';

type RouteContext = {
  params: Promise<{ id: string }>;
};

const updateSchema = z.object({
  status: z.enum(['NEW', 'IN_PROGRESS', 'DONE', 'ESCALATED']).optional(),
  internalLabel: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  assignedUserId: z.string().nullable().optional(),
});

const actionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('reply'),
    message: z.string().min(1).max(8000),
  }),
  z.object({
    action: z.literal('like'),
  }),
  z.object({
    action: z.literal('unlike'),
  }),
  z.object({
    action: z.literal('hide'),
  }),
  z.object({
    action: z.literal('unhide'),
  }),
  z.object({
    action: z.literal('delete'),
  }),
]);

/**
 * GET - Get single comment with full details
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;

    const comment = await prisma.socialComment.findUnique({
      where: { id },
      include: {
        account: {
          select: {
            id: true,
            name: true,
            platform: true,
            profilePictureUrl: true,
            username: true,
          },
        },
        object: {
          select: {
            id: true,
            type: true,
            externalId: true,
            message: true,
            thumbnailUrl: true,
            permalink: true,
            mediaType: true,
            adId: true,
            adName: true,
            adsetId: true,
            adsetName: true,
            campaignId: true,
            campaignName: true,
            destinationUrl: true,
            publishedAt: true,
          },
        },
        parent: {
          select: {
            id: true,
            authorName: true,
            message: true,
            commentedAt: true,
          },
        },
        replies: {
          where: { deleted: false },
          orderBy: { commentedAt: 'asc' },
          include: {
            replies: {
              where: { deleted: false },
              orderBy: { commentedAt: 'asc' },
              select: {
                id: true,
                authorName: true,
                authorUsername: true,
                authorProfileUrl: true,
                message: true,
                isPageOwner: true,
                commentedAt: true,
                hidden: true,
                likeCount: true,
              },
            },
          },
        },
        ruleRuns: {
          where: { matched: true },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            rule: {
              select: {
                id: true,
                name: true,
              },
            },
            actionsExecuted: true,
            wasDryRun: true,
            wasFlagged: true,
            createdAt: true,
          },
        },
        actionLogs: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            actionType: true,
            actorType: true,
            actorName: true,
            details: true,
            apiSuccess: true,
            apiError: true,
            createdAt: true,
          },
        },
      },
    });

    if (!comment) {
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
    }

    return NextResponse.json({ comment });
  } catch (err) {
    console.error('Error fetching social comment:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * PATCH - Update comment metadata (status, label, notes)
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'CHANGE_STATUS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;
    const body = await request.json();
    const data = updateSchema.parse(body);

    const comment = await prisma.socialComment.findUnique({
      where: { id },
    });

    if (!comment) {
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
    }

    // Track what changed for logging
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    if (data.status !== undefined && data.status !== comment.status) {
      changes.status = { from: comment.status, to: data.status };
    }
    if (data.internalLabel !== undefined && data.internalLabel !== comment.internalLabel) {
      changes.internalLabel = { from: comment.internalLabel, to: data.internalLabel };
    }
    if (data.assignedUserId !== undefined && data.assignedUserId !== comment.assignedUserId) {
      changes.assignedUserId = { from: comment.assignedUserId, to: data.assignedUserId };
    }

    // Update comment
    const updated = await prisma.socialComment.update({
      where: { id },
      data: {
        status: data.status as SocialCommentStatus | undefined,
        internalLabel: data.internalLabel,
        notes: data.notes,
        assignedUserId: data.assignedUserId,
      },
    });

    // Log changes
    if (Object.keys(changes).length > 0) {
      const actionType: SocialActionType = data.status
        ? 'STATUS_CHANGED'
        : data.internalLabel !== undefined
        ? data.internalLabel
          ? 'LABEL_ADDED'
          : 'LABEL_REMOVED'
        : data.assignedUserId !== undefined
        ? data.assignedUserId
          ? 'ASSIGNED'
          : 'UNASSIGNED'
        : 'NOTE_ADDED';

      await prisma.socialActionLog.create({
        data: {
          commentId: id,
          actionType,
          actorType: 'user',
          actorId: session.user.id,
          actorName: session.user.name,
          details: JSON.parse(JSON.stringify(changes)),
          apiSuccess: true,
        },
      });
    }

    return NextResponse.json({ success: true, comment: updated });
  } catch (err) {
    console.error('Error updating social comment:', err);
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
 * POST - Perform an action on the comment (reply, like, hide, delete)
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'REPLY_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;
    const body = await request.json();
    const actionData = actionSchema.parse(body);

    const comment = await prisma.socialComment.findUnique({
      where: { id },
      include: {
        account: true,
      },
    });

    if (!comment) {
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
    }

    const client = await createMetaClient(comment.account.externalId);
    if (!client) {
      return NextResponse.json(
        { error: 'Meta integration not configured' },
        { status: 400 }
      );
    }

    let result: { success: boolean; error?: string; data?: unknown };
    let actionType: SocialActionType;
    let apiRequest: Record<string, unknown> = { action: actionData.action };

    switch (actionData.action) {
      case 'reply': {
        actionType = 'REPLY';
        apiRequest.message = actionData.message;

        if (!comment.canReply) {
          result = { success: false, error: 'Cannot reply to this comment' };
          break;
        }

        if (comment.platform === 'INSTAGRAM') {
          result = await client.replyToInstagramComment(
            comment.externalId,
            actionData.message
          );
        } else {
          result = await client.replyToComment(comment.externalId, actionData.message);
        }

        if (result.success) {
          await prisma.socialComment.update({
            where: { id },
            data: { replyCount: { increment: 1 } },
          });
        }
        break;
      }

      case 'like': {
        actionType = 'LIKE';

        if (!comment.canLike || comment.platform !== 'FACEBOOK') {
          result = { success: false, error: 'Cannot like this comment' };
          break;
        }

        result = await client.likeComment(comment.externalId);

        if (result.success) {
          await prisma.socialComment.update({
            where: { id },
            data: { isLikedByPage: true },
          });
        }
        break;
      }

      case 'unlike': {
        actionType = 'UNLIKE';

        if (comment.platform !== 'FACEBOOK') {
          result = { success: false, error: 'Unlike only supported on Facebook' };
          break;
        }

        result = await client.unlikeComment(comment.externalId);

        if (result.success) {
          await prisma.socialComment.update({
            where: { id },
            data: { isLikedByPage: false },
          });
        }
        break;
      }

      case 'hide': {
        actionType = 'HIDE';

        if (!comment.canHide || comment.platform !== 'FACEBOOK') {
          result = { success: false, error: 'Cannot hide this comment (Facebook only)' };
          break;
        }

        result = await client.hideComment(comment.externalId);

        if (result.success) {
          await prisma.socialComment.update({
            where: { id },
            data: { hidden: true },
          });
        }
        break;
      }

      case 'unhide': {
        actionType = 'UNHIDE';

        if (comment.platform !== 'FACEBOOK') {
          result = { success: false, error: 'Unhide only supported on Facebook' };
          break;
        }

        result = await client.unhideComment(comment.externalId);

        if (result.success) {
          await prisma.socialComment.update({
            where: { id },
            data: { hidden: false },
          });
        }
        break;
      }

      case 'delete': {
        actionType = 'DELETE';

        if (!comment.canDelete) {
          result = { success: false, error: 'Cannot delete this comment' };
          break;
        }

        if (comment.platform === 'INSTAGRAM') {
          result = await client.deleteInstagramComment(comment.externalId);
        } else {
          result = await client.deleteComment(comment.externalId);
        }

        if (result.success) {
          await prisma.socialComment.update({
            where: { id },
            data: { deleted: true },
          });
        }
        break;
      }

      default:
        result = { success: false, error: 'Unknown action' };
        actionType = 'REPLY'; // Fallback
    }

    // Log the action
    await prisma.socialActionLog.create({
      data: {
        commentId: id,
        actionType,
        actorType: 'user',
        actorId: session.user.id,
        actorName: session.user.name,
        details: JSON.parse(JSON.stringify({ action: actionData })),
        apiRequest: JSON.parse(JSON.stringify(apiRequest)),
        apiResponse: result.data ? JSON.parse(JSON.stringify(result.data)) : undefined,
        apiSuccess: result.success,
        apiError: result.error,
      },
    });

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || 'Action failed' },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true, data: result.data });
  } catch (err) {
    console.error('Error performing comment action:', err);
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
