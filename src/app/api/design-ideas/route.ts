/**
 * Customer-sourced design ideas: list + add.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getSession } from '@/lib/auth';
import { syncEmailDesignIdeas } from '@/lib/design-ideas';
import { logAction } from '@/lib/audit';
import { z } from 'zod';

const createSchema = z.object({
  text: z.string().min(2),
  source: z.enum(['FACEBOOK', 'INSTAGRAM', 'EMAIL', 'REVIEW', 'MANUAL']),
  authorName: z.string().optional(),
  permalink: z.string().optional(),
  sourceId: z.string().optional(),
  note: z.string().optional(),
});

export async function GET() {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Mirror any email threads tagged "Design" into the ideas list first.
  await syncEmailDesignIdeas().catch((err) =>
    console.error('Design-idea email sync failed:', err)
  );
  const ideas = await prisma.designIdea.findMany({
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  return NextResponse.json({ ideas });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = createSchema.parse(await request.json());

  // The same comment saved twice is a no-op, not a duplicate
  if (body.sourceId) {
    const existing = await prisma.designIdea.findFirst({
      where: { sourceId: body.sourceId },
    });
    if (existing) return NextResponse.json({ idea: existing, duplicate: true });
  }

  const idea = await prisma.designIdea.create({ data: body });

  // Spotting a design idea in a customer message is real work - log it so the
  // end-of-day report can credit whoever caught it.
  await logAction({
    userId: session.user.id,
    userName: session.user.name || session.user.email || 'Agent',
    action: 'design_idea_logged',
    summary: `Logged a design idea: "${idea.text.slice(0, 120)}"`,
  });

  return NextResponse.json({ idea });
}
