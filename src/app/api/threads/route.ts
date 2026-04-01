/**
 * Threads API - List and create threads
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { z } from 'zod';

// Query params schema
const listQuerySchema = z.object({
  status: z.enum(['OPEN', 'PENDING', 'CLOSED', 'TRASHED', 'ALL']).optional(),
  assigned: z.enum(['me', 'unassigned', 'all']).optional(),
  search: z.string().optional(),
  email: z.string().optional(), // Filter by customer email
  exclude: z.string().optional(), // Exclude thread ID
  tag: z.string().optional(), // Filter by tag name
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
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
    const query = listQuerySchema.parse(searchParams);

    // Build where clause
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {};

    if (query.status === 'ALL') {
      // ALL shows everything except trashed
      where.status = { in: ['OPEN', 'PENDING', 'CLOSED'] };
    } else if (query.status) {
      // Specific status filter
      where.status = query.status;
    } else {
      // Default: only show OPEN and PENDING (active inbox)
      where.status = { in: ['OPEN', 'PENDING'] };
    }

    if (query.assigned === 'me') {
      where.assignedUserId = session.user.id;
    } else if (query.assigned === 'unassigned') {
      where.assignedUserId = null;
    }

    if (query.search) {
      where.OR = [
        { subject: { contains: query.search, mode: 'insensitive' } },
        { customerEmail: { contains: query.search, mode: 'insensitive' } },
        { customerName: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    // Filter by customer email (for related threads)
    if (query.email) {
      where.customerEmail = query.email;
    }

    // Exclude specific thread ID
    if (query.exclude) {
      where.id = { not: query.exclude };
    }

    // Filter by tag name
    if (query.tag) {
      where.tags = {
        some: {
          tag: {
            name: { equals: query.tag, mode: 'insensitive' },
          },
        },
      };
    } else if (!query.status || query.status === 'ALL') {
      // Exclude threads with "Design" tag from default inbox views
      // (they have their own folder like Trash)
      where.tags = {
        none: {
          tag: {
            name: { equals: 'Design', mode: 'insensitive' },
          },
        },
      };
    }

    // Get total count
    const total = await prisma.thread.count({ where });

    // Get threads with pagination
    const threads = await prisma.thread.findMany({
      where,
      include: {
        assignedUser: {
          select: { id: true, name: true, email: true },
        },
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 1,
          select: {
            id: true,
            direction: true,
            bodyText: true,
            sentAt: true,
          },
        },
        tags: {
          include: {
            tag: {
              select: { id: true, name: true, color: true },
            },
          },
        },
        _count: {
          select: { messages: true },
        },
      },
      orderBy: { lastMessageAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });

    // Transform to include messageCount, preview, and flatten tags
    const threadsWithCount = threads.map((t) => ({
      ...t,
      messageCount: t._count.messages,
      preview: t.messages[0]?.bodyText?.slice(0, 150) || null,
      tags: t.tags.map((tt) => tt.tag),
      _count: undefined,
    }));

    return NextResponse.json({
      threads: threadsWithCount,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  } catch (err) {
    console.error('Error listing threads:', err);
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
