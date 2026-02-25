/**
 * Filter Rule API - update and delete individual rule
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
  ]).optional(),
  value: z.string().min(1).optional(),
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

    const rule = await filterRuleClient.findUnique({ where: { id } });
    if (!rule) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    }

    const updatedRule = await filterRuleClient.update({
      where: { id },
      data,
    });

    return NextResponse.json(updatedRule);
  } catch (err) {
    console.error('Error updating filter rule:', err);
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

    const rule = await filterRuleClient.findUnique({ where: { id } });
    if (!rule) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    }

    await filterRuleClient.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error deleting filter rule:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
