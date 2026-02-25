/**
 * Thread Tags API - add and list tags on a thread
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { z } from 'zod';
import { findAssignment } from '@/lib/rules';

const addTagSchema = z.object({
  tagId: z.string(),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const threadTags = await prisma.threadTag.findMany({
      where: { threadId: id },
      include: { tag: true },
      orderBy: { createdAt: 'asc' },
    });

    return NextResponse.json(threadTags.map((tt) => tt.tag));
  } catch (err) {
    console.error('Error fetching thread tags:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'REPLY_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const data = addTagSchema.parse(body);

    // Check if thread exists
    const thread = await prisma.thread.findUnique({
      where: { id },
    });

    if (!thread) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    }

    // Check if tag exists
    const tag = await prisma.tag.findUnique({
      where: { id: data.tagId },
    });

    if (!tag) {
      return NextResponse.json({ error: 'Tag not found' }, { status: 404 });
    }

    // Check if already tagged
    const existing = await prisma.threadTag.findUnique({
      where: {
        threadId_tagId: {
          threadId: id,
          tagId: data.tagId,
        },
      },
    });

    if (existing) {
      return NextResponse.json({ error: 'Thread already has this tag' }, { status: 400 });
    }

    await prisma.threadTag.create({
      data: {
        threadId: id,
        tagId: data.tagId,
      },
    });

    // Re-evaluate assignment rules (override assignment)
    const threadWithTags = await prisma.thread.findUnique({
      where: { id },
      include: {
        tags: { include: { tag: { select: { name: true } } } },
      },
    });

    if (threadWithTags) {
      const tagNames = (threadWithTags.tags || []).map((tt) => tt.tag.name);
      const assignedUserId = await findAssignment({
        subject: thread.subject,
        customerEmail: thread.customerEmail,
        bodyText: '',
        tags: tagNames,
      });

      if (assignedUserId) {
        await prisma.thread.update({
          where: { id },
          data: { assignedUserId },
        });
      }
    }

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (err) {
    console.error('Error adding thread tag:', err);
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
