/**
 * Report a customer design idea from a support thread.
 *
 * One call does three things (all idempotent / best-effort):
 *  1. Tags the thread "Design" (the existing signal the ideas list syncs from).
 *  2. Mirrors the idea into the DesignIdea table (keyed on the thread id).
 *  3. Posts it to the design-ideas Slack channel for Pati to review.
 *
 * Surfaced from the sidebar when triage flags a design suggestion.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { postToDesignIdeas } from '@/lib/slack';
import { z } from 'zod';

const schema = z.object({
  threadId: z.string().min(1),
  summary: z.string().optional(),
});

const DESIGN_TAG = 'Design';

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!hasPermission(session.user.role, 'REPLY_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { threadId, summary } = schema.parse(await request.json());

    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      select: {
        id: true,
        subject: true,
        customerName: true,
        customerEmail: true,
        messages: {
          where: { direction: 'INBOUND' },
          orderBy: { sentAt: 'asc' },
          take: 1,
          select: { bodyText: true, bodyHtml: true },
        },
      },
    });
    if (!thread) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    }

    const msg = thread.messages[0];
    const ideaText = (
      msg?.bodyText ||
      msg?.bodyHtml?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ') ||
      summary ||
      ''
    ).trim();

    // 1. Tag the thread "Design" (find-or-create the tag), idempotent.
    const tag = await prisma.tag.upsert({
      where: { name: DESIGN_TAG },
      update: {},
      create: { name: DESIGN_TAG, color: '#8b5cf6' },
    });
    await prisma.threadTag.upsert({
      where: { threadId_tagId: { threadId, tagId: tag.id } },
      update: {},
      create: { threadId, tagId: tag.id },
    });

    // 2. Mirror into DesignIdea, idempotent on the thread id.
    const existing = await prisma.designIdea.findFirst({
      where: { sourceId: threadId },
    });
    const idea =
      existing ||
      (await prisma.designIdea.create({
        data: {
          text: (ideaText || summary || 'Design idea').slice(0, 4000),
          source: 'EMAIL',
          authorName: thread.customerName || thread.customerEmail,
          permalink: `/inbox?thread=${threadId}`,
          sourceId: threadId,
          note: summary || undefined,
        },
      }));

    // 3. Post to the design-ideas Slack channel (best-effort; no-op if the
    //    SLACK_DESIGN_IDEAS_WEBHOOK_URL env var is not set).
    const base = (process.env.APP_URL || '').replace(/\/$/, '');
    const link = base ? `${base}/inbox?thread=${threadId}` : `/inbox?thread=${threadId}`;
    const who = thread.customerName
      ? `${thread.customerName} (${thread.customerEmail})`
      : thread.customerEmail;
    const slackText =
      ':bulb: *New design idea from a customer*\n' +
      (summary ? `*Idea:* ${summary}\n` : '') +
      `*From:* ${who}\n` +
      (thread.subject ? `*Subject:* ${thread.subject}\n` : '') +
      `*What they said:* ${ideaText.slice(0, 900)}${ideaText.length > 900 ? '…' : ''}\n` +
      `*Thread:* ${link}`;
    const slackPosted = await postToDesignIdeas(slackText);

    return NextResponse.json({
      reported: true,
      slackPosted,
      ideaId: idea.id,
      duplicate: !!existing,
    });
  } catch (err) {
    console.error('Error reporting design idea:', err);
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request body', details: err.issues },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
