/**
 * Canned reply update/delete - admin only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, isAdmin } from '@/lib/auth';
import prisma from '@/lib/db';
import { z } from 'zod';

const updateSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  category: z.string().max(60).nullable().optional(),
  body: z.string().min(1).max(5000).optional(),
  sortOrder: z.number().int().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const { id } = await context.params;
    const data = updateSchema.parse(await request.json());
    const reply = await prisma.cannedReply.update({ where: { id }, data });
    return NextResponse.json(reply);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    console.error('Error updating canned reply:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const { id } = await context.params;
    await prisma.cannedReply.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error deleting canned reply:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
