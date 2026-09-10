/**
 * The ready-to-send "we drew the thing you asked for" note for one idea.
 *
 * Kept on the server so the wording lives in one place next to the rest of the
 * brand voice, instead of being retyped into the page component.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getSession } from '@/lib/auth';
import { buildMadeItNote, buildMadeItComment } from '@/lib/design-ideas';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await context.params;
  const idea = await prisma.designIdea.findUnique({ where: { id } });
  if (!idea) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const note = buildMadeItNote(idea);
  return NextResponse.json({ ...note, comment: buildMadeItComment(idea) });
}
