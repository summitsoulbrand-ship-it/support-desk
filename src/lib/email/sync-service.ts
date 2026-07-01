/**
 * Shared email sync service
 * Single sync implementation used by both the manual /api/sync route and the
 * background worker, so attachment storage, auto-merge, and tag rules behave
 * identically regardless of who triggers the sync.
 */

import prisma from '@/lib/db';
import { Prisma } from '@prisma/client';
import { createEmailProvider } from '@/lib/email';
import { applyRulesToThread } from '@/lib/rules';

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

/** A sync job is considered stuck/stale after this many ms */
const RUNNING_JOB_STALE_MS = 5 * 60 * 1000;

export interface EmailSyncOutcome {
  success: boolean;
  skipped?: boolean;
  messagesProcessed: number;
  /** Threads that received at least one new INBOUND message in this run */
  newInboundThreadIds: string[];
  error?: string;
}

/**
 * Run email synchronization for the active mailbox.
 * Safe to call concurrently from the web app and the worker: if another sync
 * job is already RUNNING (and not stale), this run is skipped.
 */
export async function runEmailSync(): Promise<EmailSyncOutcome> {
  const newInboundThreadIds = new Set<string>();

  // Get or create mailbox
  let mailbox = await prisma.mailbox.findFirst({
    where: { active: true },
  });

  if (!mailbox) {
    const settings = await prisma.integrationSettings.findUnique({
      where: { type: 'ZOHO_IMAP_SMTP' },
    });

    if (!settings || !settings.enabled) {
      return {
        success: false,
        messagesProcessed: 0,
        newInboundThreadIds: [],
        error: 'Email integration not configured',
      };
    }

    const { decryptJson } = await import('@/lib/encryption');
    const config = decryptJson<{ username: string }>(settings.encryptedData);

    mailbox = await prisma.mailbox.create({
      data: {
        displayName: 'Support Inbox',
        emailAddress: config.username,
        provider: 'ZOHO_IMAP',
      },
    });
  }

  // Concurrency guard: skip if another sync is already running for this mailbox
  const runningJob = await prisma.syncJob.findFirst({
    where: {
      mailboxId: mailbox.id,
      status: 'RUNNING',
      startedAt: { gte: new Date(Date.now() - RUNNING_JOB_STALE_MS) },
    },
  });

  if (runningJob) {
    console.log(
      `[Sync] Skipping: sync job ${runningJob.id} already running for ${mailbox.emailAddress}`
    );
    return {
      success: true,
      skipped: true,
      messagesProcessed: 0,
      newInboundThreadIds: [],
    };
  }

  const job = await prisma.syncJob.create({
    data: {
      mailboxId: mailbox.id,
      status: 'RUNNING',
      startedAt: new Date(),
    },
  });

  // The findFirst-then-create above is racy between the web /api/sync route and
  // the worker tick: both can pass the check and create a RUNNING job. Re-check
  // AFTER creating ours - the job with the earliest (startedAt, id) wins, so
  // exactly one caller proceeds and the loser yields cleanly instead of both
  // syncing and one failing mid-thread with a spurious mailbox.syncError.
  const competingJobs = await prisma.syncJob.findMany({
    where: {
      mailboxId: mailbox.id,
      status: 'RUNNING',
      id: { not: job.id },
      startedAt: { gte: new Date(Date.now() - RUNNING_JOB_STALE_MS) },
    },
    select: { id: true, startedAt: true },
  });
  const ourStartedAt = job.startedAt?.getTime() ?? 0;
  const loser = competingJobs.some((other) => {
    const otherStartedAt = other.startedAt?.getTime() ?? 0;
    return (
      otherStartedAt < ourStartedAt ||
      (otherStartedAt === ourStartedAt && other.id < job.id)
    );
  });
  if (loser) {
    // Remove our never-ran claim so it doesn't linger as a phantom RUNNING job
    await prisma.syncJob.delete({ where: { id: job.id } });
    console.log(
      `[Sync] Skipping: lost concurrent claim for ${mailbox.emailAddress}`
    );
    return {
      success: true,
      skipped: true,
      messagesProcessed: 0,
      newInboundThreadIds: [],
    };
  }

  const emailProvider = await createEmailProvider();
  if (!emailProvider) {
    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage: 'Email provider not available',
      },
    });
    return {
      success: false,
      messagesProcessed: 0,
      newInboundThreadIds: [],
      error: 'Email provider not configured',
    };
  }

  try {
    const syncState = {
      lastSyncAt: mailbox.lastSyncAt || undefined,
      lastSyncUid: mailbox.lastSyncUid || undefined,
      uidValidity: mailbox.uidValidity || undefined,
    };

    const result = await emailProvider.syncNewMessages(syncState);

    if (result.error) {
      throw new Error(result.error);
    }

    let messagesProcessed = 0;

    if (result.newMessages.length > 0) {
      const threads = emailProvider.groupIntoThreads(result.newMessages);

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

        let dbThread = await prisma.thread.findFirst({
          where: {
            mailboxId: mailbox.id,
            providerThreadKey: thread.threadKey,
          },
        });

        let isNewThread = false;
        if (!dbThread) {
          // Contact-form submissions merge only on the extracted customer
          // email (a confident signal) - name-only matching could glue
          // unrelated submissions together. Direct emails merge on either.
          const isContactForm = isContactFormSubject(thread.subject);
          const contactFormHasRealEmail =
            !!thread.customerEmail &&
            thread.customerEmail.toLowerCase() !==
              mailbox.emailAddress.toLowerCase();
          const canMerge = isContactForm
            ? contactFormHasRealEmail
            : !!(thread.customerEmail || thread.customerName);
          if (autoMerge && canMerge) {
            const mergeWindowDate = new Date();
            mergeWindowDate.setHours(mergeWindowDate.getHours() - mergeWindowHours);

            const emailForMatch =
              thread.customerEmail && (!isContactForm || contactFormHasRealEmail)
                ? thread.customerEmail
                : null;

            const matchConditions: Prisma.ThreadWhereInput[] = [];
            if (emailForMatch) {
              matchConditions.push({
                customerEmail: {
                  equals: emailForMatch,
                  mode: 'insensitive' as const,
                },
              });
            }
            if (
              !isContactForm &&
              thread.customerName &&
              thread.customerName.trim().length >= 3
            ) {
              const nameMatch = {
                customerName: {
                  equals: thread.customerName,
                  mode: 'insensitive' as const,
                },
              };
              // A name match must NOT glue this message onto a thread that
              // belongs to a DIFFERENT email address - that merges two different
              // customers who happen to share a name (the reported bug). Only
              // allow name-match when the candidate thread has no email of its
              // own, or the same email as this message.
              if (emailForMatch) {
                matchConditions.push({
                  AND: [
                    nameMatch,
                    {
                      OR: [
                        { customerEmail: '' },
                        {
                          customerEmail: {
                            equals: emailForMatch,
                            mode: 'insensitive' as const,
                          },
                        },
                      ],
                    },
                  ],
                });
              } else {
                matchConditions.push(nameMatch);
              }
            }

            const existingThread = await prisma.thread.findFirst({
              where: {
                mailboxId: mailbox.id,
                OR: matchConditions,
                status: { in: ['OPEN', 'PENDING', 'CLOSED'] },
                lastMessageAt: { gte: mergeWindowDate },
              },
              orderBy: { lastMessageAt: 'desc' },
            });

            if (existingThread) {
              dbThread = existingThread;
              console.log(`[AutoMerge] Merging new messages into existing thread ${existingThread.id} for customer ${thread.customerEmail || thread.customerName}`);
            }
          }

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
          const existing = await prisma.message.findFirst({
            where: {
              OR: [
                { providerMessageId: msg.messageId },
                { threadId: dbThread.id, imapUid: msg.uid },
              ],
            },
          });

          if (!existing) {
            // Store attachment bytes in the DB so the web service (separate
            // ephemeral filesystem from the worker) can serve them.
            const attachmentsWithStorage = (msg.attachments || []).map((att) => ({
              filename: att.filename,
              mimeType: att.mimeType,
              size: att.size,
              contentId: att.contentId,
              content: att.content ? Buffer.from(att.content) : null,
            }));

            const isInbound =
              msg.from.address.toLowerCase() !== mailbox.emailAddress.toLowerCase();

            try {
              await prisma.message.create({
                data: {
                  threadId: dbThread.id,
                  providerMessageId: msg.messageId,
                  imapUid: msg.uid,
                  direction: isInbound ? 'INBOUND' : 'OUTBOUND',
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
                    create: attachmentsWithStorage.map((att) => ({
                      filename: att.filename,
                      mimeType: att.mimeType,
                      size: att.size,
                      contentId: att.contentId,
                      content: att.content || undefined,
                    })),
                  },
                },
              });
            } catch (createErr) {
              // A concurrent sync (web route + worker overlapping) can insert
              // the same providerMessageId between our findFirst and create.
              // That message is already synced - skip it instead of failing
              // the whole run with a spurious mailbox.syncError.
              if (
                createErr instanceof Prisma.PrismaClientKnownRequestError &&
                createErr.code === 'P2002'
              ) {
                console.log(
                  `[Sync] Skipping duplicate message ${msg.messageId} (already synced concurrently)`
                );
                continue;
              }
              throw createErr;
            }
            messagesProcessed++;

            if (isInbound) {
              newInboundThreadIds.add(dbThread.id);
            }
          }
        }

        // Update thread last message time, reopen on new inbound
        await prisma.thread.update({
          where: { id: dbThread.id },
          data: {
            lastMessageAt: thread.lastMessageAt,
            status: thread.messages.some(
              (m) =>
                m.from.address.toLowerCase() !== mailbox.emailAddress.toLowerCase()
            )
              ? 'OPEN'
              : undefined,
          },
        });

        // Apply auto-tagging and assignment rules for new threads
        if (isNewThread) {
          const firstInboundMsg = thread.messages.find(
            (m) => m.from.address.toLowerCase() !== mailbox.emailAddress.toLowerCase()
          );

          await applyRulesToThread(dbThread.id, {
            subject: thread.subject,
            customerEmail: thread.customerEmail,
            bodyText: firstInboundMsg?.bodyText || '',
          });
        }
      }
    }

    await prisma.mailbox.update({
      where: { id: mailbox.id },
      data: {
        lastSyncAt: result.syncState.lastSyncAt,
        lastSyncUid: result.syncState.lastSyncUid,
        uidValidity: result.syncState.uidValidity,
        syncError: null,
      },
    });

    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        messagesProcessed,
      },
    });

    // A new inbound message invalidates any pre-generated AI draft; the
    // triage pipeline picks these threads up and regenerates.
    if (newInboundThreadIds.size > 0) {
      await prisma.aiDraft.updateMany({
        where: {
          threadId: { in: [...newInboundThreadIds] },
          status: 'READY',
        },
        data: { status: 'STALE' },
      });
    }

    return {
      success: true,
      messagesProcessed,
      newInboundThreadIds: [...newInboundThreadIds],
    };
  } catch (syncErr) {
    const errorMessage =
      syncErr instanceof Error ? syncErr.message : 'Unknown error';

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

    return {
      success: false,
      messagesProcessed: 0,
      newInboundThreadIds: [...newInboundThreadIds],
      error: errorMessage,
    };
  } finally {
    await emailProvider.disconnect();
  }
}
