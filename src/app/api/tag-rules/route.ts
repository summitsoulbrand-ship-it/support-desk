/**
 * Tag Rules API - create and list auto-tagging rules
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { z } from 'zod';

import { Prisma } from '@prisma/client';

/**
 * Apply a single tag rule to all existing threads
 */
async function applyRuleToExistingThreads(
  condition: string,
  value: string,
  tagId: string
): Promise<number> {
  const lowerValue = value.toLowerCase();

  // Build the query based on condition
  let whereClause: Prisma.ThreadWhereInput | undefined;

  switch (condition) {
    case 'SUBJECT_CONTAINS':
      whereClause = {
        subject: { contains: lowerValue, mode: 'insensitive' },
      };
      break;

    case 'SUBJECT_STARTS_WITH':
      whereClause = {
        subject: { startsWith: lowerValue, mode: 'insensitive' },
      };
      break;

    case 'EMAIL_CONTAINS':
      whereClause = {
        customerEmail: { contains: lowerValue, mode: 'insensitive' },
      };
      break;

    case 'EMAIL_DOMAIN':
      whereClause = {
        customerEmail: { endsWith: `@${lowerValue}`, mode: 'insensitive' },
      };
      break;

    case 'BODY_CONTAINS':
      // For body matching, we need to check messages
      // This is more complex - we'll do it in memory
      break;

    default:
      return 0;
  }

  let matchingThreadIds: string[] = [];

  if (condition === 'BODY_CONTAINS') {
    // For body matching, get threads with their first inbound message
    const threads = await prisma.thread.findMany({
      where: { status: { not: 'TRASHED' } },
      select: {
        id: true,
        messages: {
          where: { direction: 'INBOUND' },
          select: { bodyText: true },
          take: 1,
          orderBy: { sentAt: 'asc' },
        },
      },
    });

    matchingThreadIds = threads
      .filter((t) =>
        t.messages.some((m) =>
          (m.bodyText || '').toLowerCase().includes(lowerValue)
        )
      )
      .map((t) => t.id);
  } else if (whereClause) {
    const threads = await prisma.thread.findMany({
      where: {
        ...whereClause,
        status: { not: 'TRASHED' },
      },
      select: { id: true },
    });
    matchingThreadIds = threads.map((t) => t.id);
  }

  // Add tag to matching threads (ignore duplicates)
  let tagsAdded = 0;
  for (const threadId of matchingThreadIds) {
    try {
      await prisma.threadTag.create({
        data: { threadId, tagId },
      });
      tagsAdded++;
    } catch {
      // Ignore duplicate key errors - thread already has this tag
    }
  }

  return tagsAdded;
}

const createRuleSchema = z.object({
  tagId: z.string(),
  condition: z.enum([
    'SUBJECT_CONTAINS',
    'SUBJECT_STARTS_WITH',
    'EMAIL_CONTAINS',
    'EMAIL_DOMAIN',
    'BODY_CONTAINS',
  ]),
  value: z.string().min(1),
});

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const rules = await prisma.tagRule.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        tag: {
          select: { id: true, name: true, color: true },
        },
      },
    });

    return NextResponse.json(rules);
  } catch (err) {
    console.error('Error fetching tag rules:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'REPLY_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const data = createRuleSchema.parse(body);

    // Check if tag exists
    const tag = await prisma.tag.findUnique({
      where: { id: data.tagId },
    });

    if (!tag) {
      return NextResponse.json({ error: 'Tag not found' }, { status: 404 });
    }

    const rule = await prisma.tagRule.create({
      data: {
        tagId: data.tagId,
        condition: data.condition,
        value: data.value,
      },
      include: {
        tag: {
          select: { id: true, name: true, color: true },
        },
      },
    });

    // Apply rule to existing threads in the background
    applyRuleToExistingThreads(data.condition, data.value, data.tagId)
      .then((count) => {
        if (count > 0) {
          console.log(`Tag rule applied to ${count} existing threads`);
        }
      })
      .catch((err) => {
        console.error('Error applying rule to existing threads:', err);
      });

    return NextResponse.json(rule, { status: 201 });
  } catch (err) {
    console.error('Error creating tag rule:', err);
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request body', details: err.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
