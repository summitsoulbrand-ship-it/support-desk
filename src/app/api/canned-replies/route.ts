/**
 * Canned replies / macros - reusable FAQ answers.
 * GET: any signed-in agent (to use them). POST: admin (to manage).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, isAdmin } from '@/lib/auth';
import prisma from '@/lib/db';
import { z } from 'zod';

const createSchema = z.object({
  title: z.string().min(1).max(120),
  category: z.string().max(60).optional(),
  body: z.string().min(1).max(5000),
  sortOrder: z.number().int().optional(),
});

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const replies = await prisma.cannedReply.findMany({
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    });
    return NextResponse.json({ replies });
  } catch (err) {
    console.error('Error fetching canned replies:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
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
    const data = createSchema.parse(await request.json());
    const reply = await prisma.cannedReply.create({ data });
    return NextResponse.json(reply, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request', details: err.issues },
        { status: 400 }
      );
    }
    console.error('Error creating canned reply:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
