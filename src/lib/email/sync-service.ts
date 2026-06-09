/**
 * Shared email sync service
 * Single sync implementation used by both the manual /api/sync route and the
 * background worker, so attachment storage, auto-merge, and tag rules behave
 * identically regardless of who triggers the sync.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import prisma from '@/lib/db';
import { ensureAttachmentsDir } from '@/lib/storage';
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
          // Skip auto-merge for contact form emails - each submission is a new topic
          const skipAutoMerge = isContactFormSubject(thread.subject);
          if (autoMerge && !skipAutoMerge && (thread.customerEmail || thread.customerName)) {
            const mergeWindowDate = new Date();
            mergeWindowDate.setHours(mergeWindowDate.getHours() - mergeWindowHours);

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
            const attachmentsWithStorage = await Promise.all(
              (msg.attachments || []).map(async (att) => {
                if (!att.content) {
                  return {
                    filename: att.filename,
                    mimeType: att.mimeType,
                    size: att.size,
                    contentId: att.contentId,
                    storagePath: null as string | null,
                  };
                }

                const dir = await ensureAttachmentsDir();
                const ext =
                  path.extname(att.filename || '') ||
                  `.${att.mimeType.split('/')[1] || 'bin'}`;
                const fileName = `${crypto.randomUUID()}${ext}`;
                const filePath = path.join(dir, fileName);

                await fs.writeFile(filePath, att.content);

                return {
                  filename: att.filename,
                  mimeType: att.mimeType,
                  size: att.size,
                  contentId: att.contentId,
                  storagePath: filePath,
                };
              })
            );

            const isInbound =
              msg.from.address.toLowerCase() !== mailbox.emailAddress.toLowerCase();

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
                    storagePath: att.storagePath || undefined,
                  })),
                },
              },
            });
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
