/**
 * Thread detail API - Get, update, and delete a specific thread
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission, isAdmin } from '@/lib/auth';
import prisma from '@/lib/db';
import { personalizeDraftSignature } from '@/lib/ai/signature';
import { isUnsubscribeText, plainTextFromMessage } from '@/lib/unsubscribe-detect';
import { z } from 'zod';

// Update schema
const updateSchema = z.object({
  status: z.enum(['OPEN', 'PENDING', 'CLOSED', 'TRASHED']).optional(),
  assignedUserId: z.string().nullable().optional(),
});

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;

    const thread = await prisma.thread.findUnique({
      where: { id },
      include: {
        assignedUser: {
          select: { id: true, name: true, email: true },
        },
        messages: {
          orderBy: { sentAt: 'asc' },
          include: {
            attachments: true,
          },
        },
        mailbox: {
          select: { id: true, displayName: true, emailAddress: true },
        },
        tags: {
          include: { tag: true },
          orderBy: { createdAt: 'asc' },
        },
        triage: true,
        aiDraft: true,
      },
    });

    if (!thread) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    }

    // Pre-written drafts are signed by the primary admin; if a different
    // agent is viewing, swap in THEIR signature so the reply they send is
    // signed correctly.
    if (thread.aiDraft?.body) {
      thread.aiDraft.body = await personalizeDraftSignature(
        thread.aiDraft.body,
        session.user.id
      );
    }

    // Self-heal: an obvious opt-out that was classified before the UNSUBSCRIBE
    // intent existed (or that the model missed) gets corrected on view, so the
    // badge and action card line up.
    if (thread.triage && thread.triage.intent !== 'UNSUBSCRIBE') {
      const latestInbound = [...thread.messages]
        .reverse()
        .find((m) => m.direction === 'INBOUND');
      if (isUnsubscribeText(plainTextFromMessage(latestInbound))) {
        thread.triage.intent = 'UNSUBSCRIBE';
        await prisma.threadTriage
          .update({
            where: { threadId: thread.id },
            data: { intent: 'UNSUBSCRIBE', confidence: 0.95 },
          })
          .catch(() => undefined);
      }
    }

    // Resolve who sent each outbound reply (agent vs Pati) so the thread can
    // show it next to "Sent". sentByUserId has no relation, so look the names
    // up in one query.
    const senderIds = [
      ...new Set(
        thread.messages
          .filter((m) => m.direction === 'OUTBOUND' && m.sentByUserId)
          .map((m) => m.sentByUserId as string)
      ),
    ];
    const senders = senderIds.length
      ? await prisma.user.findMany({
          where: { id: { in: senderIds } },
          select: { id: true, name: true },
        })
      : [];
    const senderById = new Map(senders.map((u) => [u.id, u.name]));

    // Transform tags to be easier to use (with safeguard)
    const transformedThread = {
      ...thread,
      tags: (thread.tags || []).map((tt) => tt.tag),
      messages: thread.messages.map((m) => ({
        ...m,
        sentByName: m.sentByUserId ? senderById.get(m.sentByUserId) ?? null : null,
        sentByYou: m.sentByUserId === session.user.id,
      })),
    };

    return NextResponse.json(transformedThread);
  } catch (err) {
    console.error('Error fetching thread:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Internal server error', details: message },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await context.params;
    const body = await request.json();
    const data = updateSchema.parse(body);

    // Check permissions based on what's being updated
    if (data.assignedUserId !== undefined && !isAdmin(session.user.role)) {
      return NextResponse.json(
        { error: 'Only admins can assign threads' },
        { status: 403 }
      );
    }

    if (data.status !== undefined) {
      if (!hasPermission(session.user.role, 'CHANGE_STATUS')) {
        return NextResponse.json(
          { error: 'Insufficient permissions to change status' },
          { status: 403 }
        );
      }
    }

    const thread = await prisma.thread.update({
      where: { id },
      data,
      include: {
        assignedUser: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    return NextResponse.json(thread);
  } catch (err) {
    console.error('Error updating thread:', err);
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

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await context.params;

    const purge = request.nextUrl.searchParams.get('purge') === 'true';

    if (purge) {
      if (!isAdmin(session.user.role)) {
        return NextResponse.json(
          { error: 'Only admins can permanently delete threads' },
          { status: 403 }
        );
      }

      const existing = await prisma.thread.findUnique({
        where: { id },
        select: { status: true },
      });

      if (!existing) {
        return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
      }

      if (existing.status !== 'TRASHED') {
        return NextResponse.json(
          { error: 'Thread must be in trash before deletion' },
          { status: 400 }
        );
      }

      await prisma.thread.delete({ where: { id } });
      return NextResponse.json({ success: true, purged: true });
    }

    if (!hasPermission(session.user.role, 'CHANGE_STATUS')) {
      return NextResponse.json(
        { error: 'Insufficient permissions to move threads to trash' },
        { status: 403 }
      );
    }

    await prisma.thread.update({
      where: { id },
      data: { status: 'TRASHED' },
    });

    return NextResponse.json({ success: true, status: 'TRASHED' });
  } catch (err) {
    console.error('Error deleting thread:', err);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: err instanceof Error ? err.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
