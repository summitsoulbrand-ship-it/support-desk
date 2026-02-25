/**
 * Assignment Rules API - list and create assignment rules
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, isAdmin } from '@/lib/auth';
import prisma from '@/lib/db';
import { z } from 'zod';

const createRuleSchema = z.object({
  name: z.string().min(1).max(100),
  condition: z.enum([
    'SUBJECT_CONTAINS',
    'SUBJECT_STARTS_WITH',
    'EMAIL_CONTAINS',
    'EMAIL_DOMAIN',
    'BODY_CONTAINS',
    'WEEKDAY',
    'TIME_RANGE',
    'HAS_TAG',
  ]),
  value: z.string().min(1),
  assignToId: z.string(),
  priority: z.number().int().min(0).max(100).optional(),
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

    const rules = await prisma.assignmentRule.findMany({
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      include: {
        assignTo: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    return NextResponse.json(rules);
  } catch (err) {
    console.error('Error fetching assignment rules:', err);
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

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id: data.assignToId },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const rule = await prisma.assignmentRule.create({
      data: {
        name: data.name,
        condition: data.condition,
        value: data.value,
        assignToId: data.assignToId,
        priority: data.priority || 0,
      },
      include: {
        assignTo: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    return NextResponse.json(rule, { status: 201 });
  } catch (err) {
    console.error('Error creating assignment rule:', err);
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
