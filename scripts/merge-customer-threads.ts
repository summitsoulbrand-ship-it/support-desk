/**
 * Merge all threads from the same customer into one thread
 * This script consolidates existing threads by customer email
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function mergeCustomerThreads() {
  console.log('Starting thread merge by customer email...\n');

  // Find all unique customer emails with multiple threads
  const customersWithMultipleThreads = await prisma.thread.groupBy({
    by: ['customerEmail'],
    _count: { id: true },
    having: {
      id: { _count: { gt: 1 } },
    },
  });

  console.log(`Found ${customersWithMultipleThreads.length} customers with multiple threads\n`);

  let totalMerged = 0;
  let totalMessagesReassigned = 0;

  for (const customer of customersWithMultipleThreads) {
    const email = customer.customerEmail;
    console.log(`\nProcessing: ${email} (${customer._count.id} threads)`);

    // Get all threads for this customer, ordered by creation date (oldest first)
    const threads = await prisma.thread.findMany({
      where: { customerEmail: { equals: email, mode: 'insensitive' } },
      orderBy: { createdAt: 'asc' },
      include: {
        messages: { select: { id: true } },
        tags: true,
      },
    });

    if (threads.length <= 1) continue;

    // Keep the oldest thread as the primary one
    const primaryThread = threads[0];
    const threadsToMerge = threads.slice(1);

    console.log(`  Primary thread: ${primaryThread.id} (${primaryThread.subject})`);
    console.log(`  Threads to merge: ${threadsToMerge.length}`);

    for (const thread of threadsToMerge) {
      // Move all messages to the primary thread
      const messageCount = thread.messages.length;
      if (messageCount > 0) {
        await prisma.message.updateMany({
          where: { threadId: thread.id },
          data: { threadId: primaryThread.id },
        });
        console.log(`    Moved ${messageCount} messages from thread ${thread.id}`);
        totalMessagesReassigned += messageCount;
      }

      // Copy tags to primary thread (if not already present)
      for (const tag of thread.tags) {
        try {
          await prisma.threadTag.create({
            data: {
              threadId: primaryThread.id,
              tagId: tag.tagId,
            },
          });
        } catch {
          // Tag already exists on primary thread, ignore
        }
      }

      // Delete the now-empty thread
      await prisma.thread.delete({
        where: { id: thread.id },
      });
      console.log(`    Deleted merged thread ${thread.id}`);
      totalMerged++;
    }

    // Update the primary thread's lastMessageAt to the most recent message
    const latestMessage = await prisma.message.findFirst({
      where: { threadId: primaryThread.id },
      orderBy: { sentAt: 'desc' },
    });

    if (latestMessage) {
      await prisma.thread.update({
        where: { id: primaryThread.id },
        data: {
          lastMessageAt: latestMessage.sentAt,
          status: 'OPEN', // Reopen thread since it has been updated
        },
      });
    }
  }

  console.log('\n========================================');
  console.log(`Merge complete!`);
  console.log(`  Threads merged: ${totalMerged}`);
  console.log(`  Messages reassigned: ${totalMessagesReassigned}`);
  console.log('========================================\n');
}

// Run the script
mergeCustomerThreads()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
