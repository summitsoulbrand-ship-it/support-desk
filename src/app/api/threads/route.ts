/**
 * Threads API - List and create threads
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { openThreadsWhere, notDesignTaggedWhere } from '@/lib/queues';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';

// Query params schema
const listQuerySchema = z.object({
  status: z.enum(['OPEN', 'PENDING', 'CLOSED', 'TRASHED', 'ALL']).optional(),
  assigned: z.enum(['me', 'unassigned', 'all']).optional(),
  search: z.string().optional(),
  email: z.string().optional(), // Filter by customer email
  exclude: z.string().optional(), // Exclude thread ID
  tag: z.string().optional(), // Filter by tag name
  sort: z.enum(['newest', 'priority']).optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

/**
 * Work-queue priority (lower = more urgent):
 * 1 cancellations, 2 angry/frustrated customers + address changes,
 * 3 size exchanges, 4 everything else, 5 positive feedback.
 */
function threadPriority(
  triage: { intent: string; entities: unknown } | null
): number {
  if (!triage) return 4;
  if (triage.intent === 'CANCELLATION') return 1;
  const sentiment = (triage.entities as { sentiment?: string } | null)?.sentiment;
  if (sentiment === 'angry' || sentiment === 'frustrated') return 2;
  if (triage.intent === 'ADDRESS_UPDATE') return 2;
  if (triage.intent === 'SIZE_EXCHANGE') return 3;
  if (triage.intent === 'POSITIVE_FEEDBACK') return 5;
  if (triage.intent === 'SPAM') return 5;
  return 4;
}

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
      // Default: the active inbox (OPEN/PENDING, no Design tag) - the same
      // shared definition the nav badge counts, so badge and list agree.
      Object.assign(where, openThreadsWhere());
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
    } else if (query.status === 'ALL') {
      // Exclude threads with "Design" tag from default inbox views
      // (they have their own folder like Trash). The default (no status)
      // branch already gets this via openThreadsWhere().
      Object.assign(where, notDesignTaggedWhere());
    }

    // Get total count
    const total = await prisma.thread.count({ where });

    // Everything the list view displays; the raw latest message and full
    // triage entities get stripped down to derived fields before shipping.
    const listInclude = {
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
      triage: {
        select: { intent: true, confidence: true, entities: true },
      },
      aiDraft: {
        select: { status: true },
      },
      _count: {
        select: { messages: true },
      },
    } satisfies Prisma.ThreadInclude;

    let threads: Prisma.ThreadGetPayload<{ include: typeof listInclude }>[];

    if (query.sort === 'priority') {
      // Priority sort needs the whole open set in memory (it's small), but
      // only the fields the sort itself reads; the page slice is hydrated
      // with the full list includes afterwards.
      const candidates = await prisma.thread.findMany({
        where,
        select: {
          id: true,
          lastMessageAt: true,
          triage: { select: { intent: true, entities: true } },
        },
        orderBy: { lastMessageAt: 'desc' },
        take: 300,
      });

      candidates.sort((a, b) => {
        const pa = threadPriority(a.triage);
        const pb = threadPriority(b.triage);
        if (pa !== pb) return pa - pb;
        // Within a priority band: longest-waiting first
        return a.lastMessageAt.getTime() - b.lastMessageAt.getTime();
      });

      const pageIds = candidates
        .slice((query.page - 1) * query.limit, query.page * query.limit)
        .map((c) => c.id);

      const rows = await prisma.thread.findMany({
        where: { id: { in: pageIds } },
        include: listInclude,
      });
      const rowsById = new Map(rows.map((r) => [r.id, r]));
      threads = pageIds
        .map((threadId) => rowsById.get(threadId))
        .filter((t): t is NonNullable<typeof t> => !!t);
    } else {
      threads = await prisma.thread.findMany({
        where,
        include: listInclude,
        orderBy: { lastMessageAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      });
    }

    // Transform to a lean list item: derived preview / latestMessageAt /
    // messageCount replace the raw latest message (whose FULL bodyText would
    // otherwise ship for every thread), and triage is trimmed to just the
    // display fields (intent badge + sentiment) instead of the whole
    // entities JSON. The thread detail route serves the full data.
    const threadsWithCount = threads.map((t) => ({
      ...t,
      messageCount: t._count.messages,
      preview: t.messages[0]?.bodyText?.slice(0, 150) || null,
      latestMessageAt: t.messages[0]?.sentAt ?? null,
      tags: t.tags.map((tt) => tt.tag),
      triage: t.triage
        ? {
            intent: t.triage.intent,
            confidence: t.triage.confidence,
            entities: {
              sentiment: (t.triage.entities as { sentiment?: string } | null)
                ?.sentiment,
            },
          }
        : null,
      priority: threadPriority(t.triage),
      messages: undefined,
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
