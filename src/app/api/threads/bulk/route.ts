/**
 * Bulk thread actions - restore, permanently delete, or merge
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission, isAdmin } from '@/lib/auth';
import prisma from '@/lib/db';
import { z } from 'zod';

const bulkSchema = z.object({
  action: z.enum(['restore', 'purge', 'merge']),
  ids: z.array(z.string()).min(1).optional(),
  threadIds: z.array(z.string()).min(2).optional(), // For merge action
});

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const data = bulkSchema.parse(body);

    if (data.action === 'restore') {
      if (!hasPermission(session.user.role, 'CHANGE_STATUS')) {
        return NextResponse.json(
          { error: 'Insufficient permissions to restore threads' },
          { status: 403 }
        );
      }

      const result = await prisma.thread.updateMany({
        where: { id: { in: data.ids || [] }, status: 'TRASHED' },
        data: { status: 'OPEN' },
      });

      return NextResponse.json({ success: true, restored: result.count });
    }

    if (data.action === 'merge') {
      if (!hasPermission(session.user.role, 'REPLY_THREADS')) {
        return NextResponse.json(
          { error: 'Insufficient permissions to merge threads' },
          { status: 403 }
        );
      }

      const threadIds = data.threadIds;
      if (!threadIds || threadIds.length < 2) {
        return NextResponse.json(
          { error: 'At least 2 threads required to merge' },
          { status: 400 }
        );
      }

      // Get all threads to merge
      const threads = await prisma.thread.findMany({
        where: { id: { in: threadIds } },
        include: {
          messages: true,
        },
        orderBy: { createdAt: 'asc' },
      });

      if (threads.length < 2) {
        return NextResponse.json(
          { error: 'At least 2 valid threads required to merge' },
          { status: 400 }
        );
      }

      // Verify all threads are from the same customer (case-insensitive email comparison)
      const customerEmails = new Set(threads.map((t) => t.customerEmail?.toLowerCase() || ''));
      // Remove empty string if any thread has no customerEmail
      customerEmails.delete('');
      if (customerEmails.size > 1) {
        return NextResponse.json(
          { error: 'All threads must be from the same customer' },
          { status: 400 }
        );
      }

      // The first thread (by creation date) becomes the target
      const targetThread = threads[0];
      const sourceThreads = threads.slice(1);

      // Move all messages from source threads to target thread
      await prisma.$transaction(async (tx) => {
        // Update messages to point to target thread
        for (const source of sourceThreads) {
          await tx.message.updateMany({
            where: { threadId: source.id },
            data: { threadId: targetThread.id },
          });
        }

        // Update target thread's lastMessageAt to the most recent message
        const allMessages = threads.flatMap((t) => t.messages);
        const mostRecentMessage = allMessages.reduce((latest, msg) =>
          new Date(msg.sentAt) > new Date(latest.sentAt) ? msg : latest
        );

        await tx.thread.update({
          where: { id: targetThread.id },
          data: {
            lastMessageAt: mostRecentMessage.sentAt,
            status: 'OPEN', // Reopen the merged thread
          },
        });

        // Delete source threads
        await tx.thread.deleteMany({
          where: { id: { in: sourceThreads.map((t) => t.id) } },
        });
      });

      return NextResponse.json({
        success: true,
        mergedThreadId: targetThread.id,
        mergedCount: sourceThreads.length,
      });
    }

    if (!isAdmin(session.user.role)) {
      return NextResponse.json(
        { error: 'Only admins can permanently delete threads' },
        { status: 403 }
      );
    }

    const result = await prisma.thread.deleteMany({
      where: { id: { in: data.ids || [] }, status: 'TRASHED' },
    });

    return NextResponse.json({ success: true, deleted: result.count });
  } catch (err) {
    console.error('Error running bulk action:', err);
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
