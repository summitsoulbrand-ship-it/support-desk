/**
 * Auto-merge duplicate threads API
 * Merges threads from the same customer into a single thread
 * Matches by email OR by customer name
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';

interface ThreadWithMessages {
  id: string;
  customerEmail: string;
  customerName: string | null;
  createdAt: Date;
  messages: { sentAt: Date }[];
}

async function mergeThreads(
  threads: ThreadWithMessages[],
  identifier: string
): Promise<number> {
  if (threads.length < 2) return 0;

  // The first (oldest) thread becomes the target
  const targetThread = threads[0];
  const sourceThreads = threads.slice(1);

  await prisma.$transaction(async (tx) => {
    // Move messages
    for (const source of sourceThreads) {
      await tx.message.updateMany({
        where: { threadId: source.id },
        data: { threadId: targetThread.id },
      });

      // Move thread tags
      const sourceTags = await tx.threadTag.findMany({
        where: { threadId: source.id },
      });

      for (const tag of sourceTags) {
        // Check if target already has this tag
        const existing = await tx.threadTag.findFirst({
          where: { threadId: targetThread.id, tagId: tag.tagId },
        });
        if (!existing) {
          await tx.threadTag.create({
            data: { threadId: targetThread.id, tagId: tag.tagId },
          });
        }
      }

      // Delete source thread tags
      await tx.threadTag.deleteMany({
        where: { threadId: source.id },
      });
    }

    // Get most recent message time across all merged threads
    const allMessages = threads.flatMap((t) => t.messages);
    if (allMessages.length > 0) {
      const mostRecentMessage = allMessages.reduce((latest, msg) =>
        new Date(msg.sentAt) > new Date(latest.sentAt) ? msg : latest
      );

      // Update target thread
      await tx.thread.update({
        where: { id: targetThread.id },
        data: {
          lastMessageAt: mostRecentMessage.sentAt,
          status: 'OPEN',
        },
      });
    }

    // Delete source threads
    await tx.thread.deleteMany({
      where: { id: { in: sourceThreads.map((t) => t.id) } },
    });
  });

  console.log(
    `[AutoMerge] Merged ${sourceThreads.length} threads into ${targetThread.id} for customer ${identifier}`
  );

  return sourceThreads.length;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'MANAGE_SETTINGS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    let totalMerged = 0;
    const mergeResults: { customer: string; merged: number; matchedBy: string }[] = [];
    const processedThreadIds = new Set<string>();

    // 1. Find and merge by email (case-insensitive)
    const customersWithDuplicateEmails = await prisma.$queryRaw<
      { customer_email: string; thread_count: bigint }[]
    >`
      SELECT LOWER(customer_email) as customer_email, COUNT(*) as thread_count
      FROM threads
      WHERE status IN ('OPEN', 'PENDING')
      AND customer_email IS NOT NULL
      GROUP BY LOWER(customer_email)
      HAVING COUNT(*) > 1
    `;

    for (const customer of customersWithDuplicateEmails) {
      const customerEmail = customer.customer_email;

      const threads = await prisma.thread.findMany({
        where: {
          customerEmail: {
            equals: customerEmail,
            mode: 'insensitive',
          },
          status: { in: ['OPEN', 'PENDING'] },
        },
        include: {
          messages: {
            orderBy: { sentAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      if (threads.length < 2) continue;

      // Mark all these threads as processed
      threads.forEach((t) => processedThreadIds.add(t.id));

      const merged = await mergeThreads(threads, customerEmail);
      if (merged > 0) {
        totalMerged += merged;
        mergeResults.push({
          customer: customerEmail,
          merged,
          matchedBy: 'email',
        });
      }
    }

    // 2. Find and merge by name (for threads not already processed)
    const customersWithDuplicateNames = await prisma.$queryRaw<
      { customer_name: string; thread_count: bigint }[]
    >`
      SELECT LOWER(customer_name) as customer_name, COUNT(*) as thread_count
      FROM threads
      WHERE status IN ('OPEN', 'PENDING')
      AND customer_name IS NOT NULL
      AND LENGTH(TRIM(customer_name)) >= 3
      GROUP BY LOWER(customer_name)
      HAVING COUNT(*) > 1
    `;

    for (const customer of customersWithDuplicateNames) {
      const customerName = customer.customer_name;

      const threads = await prisma.thread.findMany({
        where: {
          customerName: {
            equals: customerName,
            mode: 'insensitive',
          },
          status: { in: ['OPEN', 'PENDING'] },
          // Exclude already processed threads
          id: { notIn: Array.from(processedThreadIds) },
        },
        include: {
          messages: {
            orderBy: { sentAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      if (threads.length < 2) continue;

      // Mark all these threads as processed
      threads.forEach((t) => processedThreadIds.add(t.id));

      const merged = await mergeThreads(threads, customerName);
      if (merged > 0) {
        totalMerged += merged;
        mergeResults.push({
          customer: customerName,
          merged,
          matchedBy: 'name',
        });
      }
    }

    return NextResponse.json({
      success: true,
      totalMerged,
      customersAffected: mergeResults.length,
      details: mergeResults,
    });
  } catch (err) {
    console.error('Error auto-merging threads:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
