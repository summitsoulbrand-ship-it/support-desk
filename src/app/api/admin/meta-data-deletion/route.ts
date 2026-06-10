/**
 * Meta data-deletion compliance
 * Meta periodically sends a list of app-scoped user IDs whose owners requested
 * deletion (Platform Terms 3(d)(i)). This endpoint checks those IDs against
 * everything we store keyed by Meta user IDs (comment authors, Messenger
 * participants/senders) and deletes the matching records on request.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';

const bodySchema = z.object({
  // Raw text from Meta's file - we extract anything that looks like an id
  idsText: z.string().min(1),
  // true = report matches only; false = actually delete
  dryRun: z.boolean().default(true),
});

function extractIds(text: string): string[] {
  // Meta's file is one id per line (sometimes CSV). Pull numeric tokens >= 5 chars.
  const ids = text.match(/\d{5,}/g) || [];
  return [...new Set(ids)];
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!hasPermission(session.user.role, 'MANAGE_INTEGRATIONS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { idsText, dryRun } = bodySchema.parse(await request.json());
    const ids = extractIds(idsText);

    if (ids.length === 0) {
      return NextResponse.json(
        { error: 'No user IDs found in the pasted text' },
        { status: 400 }
      );
    }

    // Everything we store keyed by Meta user ids
    const [comments, conversations, messages] = await Promise.all([
      prisma.socialComment.findMany({
        where: { authorId: { in: ids } },
        select: { id: true, authorId: true, authorName: true },
      }),
      prisma.socialConversation.findMany({
        where: { participantId: { in: ids } },
        select: { id: true, participantId: true, participantName: true },
      }),
      prisma.socialMessage.findMany({
        where: { fromId: { in: ids }, isPage: false },
        select: { id: true, conversationId: true },
      }),
    ]);

    const summary = {
      idsChecked: ids.length,
      matches: {
        comments: comments.length,
        conversations: conversations.length,
        messages: messages.length,
      },
      deleted: false,
    };

    if (dryRun) {
      return NextResponse.json(summary);
    }

    // Delete: conversations cascade their messages; stray messages whose
    // conversation isn't matched are removed explicitly; comments removed
    // outright (the comment text is the user's data).
    await prisma.$transaction([
      prisma.socialConversation.deleteMany({
        where: { participantId: { in: ids } },
      }),
      prisma.socialMessage.deleteMany({
        where: { fromId: { in: ids }, isPage: false },
      }),
      prisma.socialComment.deleteMany({
        where: { authorId: { in: ids } },
      }),
    ]);

    summary.deleted = true;
    return NextResponse.json(summary);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request', details: err.issues },
        { status: 400 }
      );
    }
    console.error('Meta data deletion error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
