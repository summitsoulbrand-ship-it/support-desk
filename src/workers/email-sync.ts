/**
 * Email sync worker
 * Runs periodic email synchronization from Zoho IMAP
 *
 * Can be run as:
 * 1. A standalone process with node-cron
 * 2. A BullMQ worker with Redis
 *
 * For MVP, we use a simple node-cron approach
 */

import { PrismaClient } from '@prisma/client';
import { createEmailProvider } from '@/lib/email';

const prisma = new PrismaClient();

/**
 * Check if a subject indicates a contact form submission
 * These should NOT be auto-merged as each submission is typically a new topic
 */
function isContactFormSubject(subject: string): boolean {
  const normalized = subject.toLowerCase();
  return normalized.includes('new customer message') ||
         normalized.includes('contact form') ||
         normalized.includes('website inquiry');
}

// Sync interval in milliseconds (default: 5 minutes)
const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL || '300000', 10);

/**
 * Run email synchronization for all active mailboxes
 */
async function syncEmails() {
  console.log(`[${new Date().toISOString()}] Starting email sync...`);

  try {
    // Get email provider
    const emailProvider = await createEmailProvider();
    if (!emailProvider) {
      console.log('Email provider not configured, skipping sync');
      return;
    }

    // Get all active mailboxes
    const mailboxes = await prisma.mailbox.findMany({
      where: { active: true },
    });

    if (mailboxes.length === 0) {
      console.log('No active mailboxes found');
      await emailProvider.disconnect();
      return;
    }

    for (const mailbox of mailboxes) {
      console.log(`Syncing mailbox: ${mailbox.emailAddress}`);

      // Create sync job
      const job = await prisma.syncJob.create({
        data: {
          mailboxId: mailbox.id,
          status: 'RUNNING',
          startedAt: new Date(),
        },
      });

      try {
        // Get current sync state
        const syncState = {
          lastSyncAt: mailbox.lastSyncAt || undefined,
          lastSyncUid: mailbox.lastSyncUid || undefined,
          uidValidity: mailbox.uidValidity || undefined,
        };

        // Sync messages
        const result = await emailProvider.syncNewMessages(syncState);

        if (result.error) {
          throw new Error(result.error);
        }

        let messagesProcessed = 0;

        if (result.newMessages.length > 0) {
          console.log(`Found ${result.newMessages.length} new messages`);

          // Group into threads
          const threads = emailProvider.groupIntoThreads(result.newMessages);

          // Get auto-merge settings
          const appSettings = await prisma.appSettings.findUnique({
            where: { id: 'default' },
          });
          const autoMerge = appSettings?.autoMergeThreads ?? true;
          const mergeWindowHours = appSettings?.autoMergeWindowHours ?? 72;

          console.log(`[Sync] Auto-merge settings: enabled=${autoMerge}, windowHours=${mergeWindowHours}`);

          for (const thread of threads) {
            // Ensure customer link exists (FK on threads.customer_email)
            if (thread.customerEmail) {
              await prisma.customerLink.upsert({
                where: { email: thread.customerEmail },
                create: { email: thread.customerEmail },
                update: {},
              });
            }

            // Find existing thread by provider thread key first
            let dbThread = await prisma.thread.findFirst({
              where: {
                mailboxId: mailbox.id,
                providerThreadKey: thread.threadKey,
              },
            });

            let isNewThread = false;
            if (dbThread) {
              console.log(`[Sync] Found existing thread ${dbThread.id} by providerThreadKey`);
            } else {
              console.log(`[Sync] No existing thread found by providerThreadKey, checking auto-merge...`);
              // If auto-merge is enabled, check for existing recent threads from same customer
              const skipAutoMerge = isContactFormSubject(thread.subject);
              console.log(`[Sync] Thread "${thread.subject}" from ${thread.customerEmail}: autoMerge=${autoMerge}, skipAutoMerge=${skipAutoMerge}`);

              if (autoMerge && !skipAutoMerge && (thread.customerEmail || thread.customerName)) {
                const mergeWindowDate = new Date();
                mergeWindowDate.setHours(mergeWindowDate.getHours() - mergeWindowHours);

                // Build conditions for matching by email or name
                const matchConditions = [];
                if (thread.customerEmail) {
                  matchConditions.push({
                    customerEmail: {
                      equals: thread.customerEmail,
                      mode: 'insensitive' as const,
                    },
                  });
                }
                if (thread.customerName && thread.customerName.trim().length >= 3) {
                  matchConditions.push({
                    customerName: {
                      equals: thread.customerName,
                      mode: 'insensitive' as const,
                    },
                  });
                }

                // Find any matching thread (including CLOSED) - we'll reopen it if needed
                console.log(`[AutoMerge] Searching for threads from ${thread.customerEmail || thread.customerName} since ${mergeWindowDate.toISOString()}`);
                const existingThread = await prisma.thread.findFirst({
                  where: {
                    mailboxId: mailbox.id,
                    OR: matchConditions,
                    status: { in: ['OPEN', 'PENDING', 'CLOSED'] },
                    lastMessageAt: { gte: mergeWindowDate },
                  },
                  orderBy: { lastMessageAt: 'desc' },
                });

                console.log(`[AutoMerge] Found existing thread: ${existingThread ? existingThread.id : 'none'}`);
                if (existingThread) {
                  dbThread = existingThread;
                  console.log(`[AutoMerge] Merging new messages into existing thread ${existingThread.id} for customer ${thread.customerEmail || thread.customerName}`);
                }
              }

              // If still no thread found, create a new one
              if (!dbThread) {
                isNewThread = true;
                dbThread = await prisma.thread.create({
                  data: {
                    mailboxId: mailbox.id,
                    providerThreadKey: thread.threadKey,
                    subject: thread.subject,
                    customerEmail: thread.customerEmail,
                    customerName: thread.customerName,
                    lastMessageAt: thread.lastMessageAt,
                    status: 'OPEN',
                  },
                });
              }
            }

            // Add messages
            for (const msg of thread.messages) {
              // Check for duplicate
              const existing = await prisma.message.findFirst({
                where: {
                  OR: [
                    { providerMessageId: msg.messageId },
                    { threadId: dbThread.id, imapUid: msg.uid },
                  ],
                },
              });

              if (!existing) {
                await prisma.message.create({
                  data: {
                    threadId: dbThread.id,
                    providerMessageId: msg.messageId,
                    imapUid: msg.uid,
                    direction:
                      msg.from.address.toLowerCase() ===
                      mailbox.emailAddress.toLowerCase()
                        ? 'OUTBOUND'
                        : 'INBOUND',
                    status: 'SENT',
                    fromAddress: msg.from.address,
                    fromName: msg.from.name,
                    toAddresses: msg.to.map((t) => t.address),
                    ccAddresses: msg.cc?.map((c) => c.address) || [],
                    subject: msg.subject,
                    bodyText: msg.bodyText,
                    bodyHtml: msg.bodyHtml,
                    inReplyTo: msg.inReplyTo,
                    references: msg.references || [],
                    sentAt: msg.date,
                    attachments: {
                      create: msg.attachments?.map((att) => ({
                        filename: att.filename,
                        mimeType: att.mimeType,
                        size: att.size,
                        contentId: att.contentId,
                      })),
                    },
                  },
                });
                messagesProcessed++;
              }
            }

            // Update thread
            const hasNewInbound = thread.messages.some(
              (m) =>
                m.from.address.toLowerCase() !==
                mailbox.emailAddress.toLowerCase()
            );

            await prisma.thread.update({
              where: { id: dbThread.id },
              data: {
                lastMessageAt: thread.lastMessageAt,
                status: hasNewInbound ? 'OPEN' : undefined,
              },
            });
          }
        }

        // Update mailbox sync state
        await prisma.mailbox.update({
          where: { id: mailbox.id },
          data: {
            lastSyncAt: result.syncState.lastSyncAt,
            lastSyncUid: result.syncState.lastSyncUid,
            uidValidity: result.syncState.uidValidity,
            syncError: null,
          },
        });

        // Complete job
        await prisma.syncJob.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            messagesProcessed,
          },
        });

        console.log(
          `Sync completed for ${mailbox.emailAddress}: ${messagesProcessed} new messages`
        );
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : 'Unknown error';
        console.error(`Sync error for ${mailbox.emailAddress}:`, errorMessage);

        await prisma.syncJob.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            completedAt: new Date(),
            errorMessage,
          },
        });

        await prisma.mailbox.update({
          where: { id: mailbox.id },
          data: { syncError: errorMessage },
        });
      }
    }

    await emailProvider.disconnect();
  } catch (err) {
    console.error('Email sync error:', err);
  }
}

/**
 * Start the sync worker
 */
async function startWorker() {
  console.log('Starting email sync worker...');
  console.log(`Sync interval: ${SYNC_INTERVAL}ms`);

  // Run initial sync
  await syncEmails();

  // Schedule periodic syncs
  setInterval(syncEmails, SYNC_INTERVAL);

  console.log('Email sync worker started');
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down email sync worker...');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down email sync worker...');
  await prisma.$disconnect();
  process.exit(0);
});

// Start worker if run directly
if (require.main === module) {
  startWorker().catch(console.error);
}

export { syncEmails, startWorker };
