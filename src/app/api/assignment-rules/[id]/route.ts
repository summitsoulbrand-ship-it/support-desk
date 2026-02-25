/**
 * Assignment Rule API - update and delete individual rule
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, isAdmin } from '@/lib/auth';
import prisma from '@/lib/db';
import { z } from 'zod';

const updateRuleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  condition: z.enum([
    'SUBJECT_CONTAINS',
    'SUBJECT_STARTS_WITH',
    'EMAIL_CONTAINS',
    'EMAIL_DOMAIN',
    'BODY_CONTAINS',
    'WEEKDAY',
    'TIME_RANGE',
    'HAS_TAG',
  ]).optional(),
  value: z.string().min(1).optional(),
  assignToId: z.string().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  enabled: z.boolean().optional(),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const data = updateRuleSchema.parse(body);

    const rule = await prisma.assignmentRule.findUnique({
      where: { id },
    });

    if (!rule) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    }

    // Check if assignTo user exists if being updated
    if (data.assignToId) {
      const user = await prisma.user.findUnique({
        where: { id: data.assignToId },
      });
      if (!user) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
      }
    }

    const updatedRule = await prisma.assignmentRule.update({
      where: { id },
      data,
      include: {
        assignTo: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    return NextResponse.json(updatedRule);
  } catch (err) {
    console.error('Error updating assignment rule:', err);
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

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const rule = await prisma.assignmentRule.findUnique({
      where: { id },
    });

    if (!rule) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    }

    await prisma.assignmentRule.delete({
      where: { id },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error deleting assignment rule:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
