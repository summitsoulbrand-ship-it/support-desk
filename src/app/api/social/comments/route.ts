/**
 * Social Comments API
 * List and manage social comments
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { z } from 'zod';
import type { Prisma, SocialPlatform, SocialCommentStatus } from '@prisma/client';

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(25),
  platforms: z.string().optional(), // Comma-separated: FACEBOOK,INSTAGRAM
  accountIds: z.string().optional(), // Comma-separated account IDs
  status: z.string().optional(), // Comma-separated: NEW,IN_PROGRESS,DONE
  hidden: z.enum(['true', 'false']).optional(),
  hasReply: z.enum(['true', 'false']).optional(),
  isAd: z.enum(['true', 'false']).optional(),
  labels: z.string().optional(), // Comma-separated labels
  search: z.string().optional(),
  sortBy: z.enum(['commentedAt', 'updatedAt', 'likeCount']).default('commentedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Parse query params
    const searchParams = Object.fromEntries(request.nextUrl.searchParams);
    const query = querySchema.parse(searchParams);

    // Build where clause
    const where: Prisma.SocialCommentWhereInput = {
      deleted: false, // Don't show deleted comments by default
    };

    // Platform filter
    if (query.platforms) {
      const platforms = query.platforms.split(',') as SocialPlatform[];
      where.platform = { in: platforms };
    }

    // Account filter
    if (query.accountIds) {
      const accountIds = query.accountIds.split(',');
      where.accountId = { in: accountIds };
    }

    // Status filter
    if (query.status) {
      const statuses = query.status.split(',') as SocialCommentStatus[];
      where.status = { in: statuses };
    }

    // Hidden filter
    if (query.hidden !== undefined) {
      where.hidden = query.hidden === 'true';
    }

    // Has reply filter (check if isPageOwner comments exist as replies)
    if (query.hasReply === 'true') {
      where.replies = {
        some: { isPageOwner: true },
      };
    } else if (query.hasReply === 'false') {
      where.replies = {
        none: { isPageOwner: true },
      };
    }

    // Is ad filter
    if (query.isAd !== undefined) {
      where.object = query.isAd === 'true'
        ? { adId: { not: null } }
        : { adId: null };
    }

    // Labels filter
    if (query.labels) {
      const labels = query.labels.split(',');
      where.internalLabel = { in: labels };
    }

    // Search filter
    if (query.search) {
      where.OR = [
        { message: { contains: query.search, mode: 'insensitive' } },
        { authorName: { contains: query.search, mode: 'insensitive' } },
        { authorUsername: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    // Only show top-level comments (not replies)
    where.parentId = null;

    // Get total count
    const total = await prisma.socialComment.count({ where });

    // Get comments with relations
    const comments = await prisma.socialComment.findMany({
      where,
      include: {
        account: {
          select: {
            id: true,
            name: true,
            platform: true,
            profilePictureUrl: true,
          },
        },
        object: {
          select: {
            id: true,
            type: true,
            message: true,
            thumbnailUrl: true,
            permalink: true,
            adId: true,
            adName: true,
            campaignName: true,
          },
        },
        replies: {
          where: { deleted: false },
          select: {
            id: true,
            authorName: true,
            message: true,
            isPageOwner: true,
            commentedAt: true,
          },
          orderBy: { commentedAt: 'asc' },
          take: 5, // Only include first 5 replies in list view
        },
        _count: {
          select: { replies: true },
        },
      },
      orderBy: { [query.sortBy]: query.sortOrder },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });

    // Format response
    const formattedComments = comments.map((comment) => ({
      id: comment.id,
      platform: comment.platform,
      externalId: comment.externalId,
      authorName: comment.authorName,
      authorUsername: comment.authorUsername,
      authorProfileUrl: comment.authorProfileUrl,
      message: comment.message,
      hidden: comment.hidden,
      deleted: comment.deleted,
      status: comment.status,
      likeCount: comment.likeCount,
      replyCount: comment._count.replies,
      isLikedByPage: comment.isLikedByPage,
      internalLabel: comment.internalLabel,
      commentedAt: comment.commentedAt,
      canHide: comment.canHide,
      canDelete: comment.canDelete,
      canReply: comment.canReply,
      canLike: comment.canLike,
      permalink: comment.permalink,
      account: comment.account,
      object: comment.object,
      hasPageReply: comment.replies.some((r) => r.isPageOwner),
      previewReplies: comment.replies,
    }));

    return NextResponse.json({
      comments: formattedComments,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  } catch (err) {
    console.error('Error fetching social comments:', err);
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid query parameters', details: err.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
