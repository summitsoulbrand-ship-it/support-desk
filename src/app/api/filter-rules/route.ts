/**
 * Filter Rules API - create and list auto-trash rules
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, isAdmin } from '@/lib/auth';
import prisma from '@/lib/db';
import { z } from 'zod';
import { Prisma } from '@prisma/client';

async function applyRuleToExistingThreads(
  condition: string,
  value: string
): Promise<number> {
  const lowerValue = value.toLowerCase();
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
    default:
      return 0;
  }

  const result = await prisma.thread.updateMany({
    where: {
      ...whereClause,
      status: { not: 'TRASHED' },
    },
    data: { status: 'TRASHED' },
  });

  return result.count;
}

const createRuleSchema = z.object({
  name: z.string().min(1).max(100),
  condition: z.enum([
    'SUBJECT_CONTAINS',
    'SUBJECT_STARTS_WITH',
    'EMAIL_CONTAINS',
    'EMAIL_DOMAIN',
  ]),
  value: z.string().min(1),
  applyToExisting: z.boolean().optional(),
});

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const filterRuleClient = (prisma as typeof prisma & { filterRule?: typeof prisma.filterRule }).filterRule;
    if (!filterRuleClient) {
      return NextResponse.json(
        {
          error: 'Filter rules not available',
          details: 'Prisma client is out of date. Restart the server after running prisma generate.',
        },
        { status: 500 }
      );
    }

    const rules = await filterRuleClient.findMany({
      orderBy: { createdAt: 'asc' },
    });

    return NextResponse.json(rules);
  } catch (err) {
    console.error('Error fetching filter rules:', err);
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

    if (!isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const data = createRuleSchema.parse(body);

    const filterRuleClient = (prisma as typeof prisma & { filterRule?: typeof prisma.filterRule }).filterRule;
    if (!filterRuleClient) {
      return NextResponse.json(
        {
          error: 'Filter rules not available',
          details: 'Prisma client is out of date. Restart the server after running prisma generate.',
        },
        { status: 500 }
      );
    }

    const rule = await filterRuleClient.create({
      data: {
        name: data.name,
        condition: data.condition,
        value: data.value,
      },
    });

    let appliedCount = 0;
    let applyError: string | null = null;
    if (data.applyToExisting) {
      try {
        appliedCount = await applyRuleToExistingThreads(
          data.condition,
          data.value
        );
      } catch (err) {
        applyError = err instanceof Error ? err.message : 'Apply failed';
      }
    }

    return NextResponse.json(
      { ...rule, appliedCount, applyError },
      { status: 201 }
    );
  } catch (err) {
    console.error('Error creating filter rule:', err);
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request body', details: err.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: err instanceof Error ? err.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
