/**
 * Thread detail API - Get, update, and delete a specific thread
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission, isAdmin } from '@/lib/auth';
import prisma from '@/lib/db';
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
      },
    });

    if (!thread) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    }

    // Transform tags to be easier to use (with safeguard)
    const transformedThread = {
      ...thread,
      tags: (thread.tags || []).map((tt) => tt.tag),
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
