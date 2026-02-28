/**
 * Email sync API - Trigger manual sync or get sync status
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureAttachmentsDir } from '@/lib/storage';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { createEmailProvider } from '@/lib/email';
import { applyRulesToThread } from '@/lib/rules';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get recent sync jobs
    const jobs = await prisma.syncJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    // Get mailbox status
    const mailboxes = await prisma.mailbox.findMany({
      select: {
        id: true,
        displayName: true,
        emailAddress: true,
        lastSyncAt: true,
        syncError: true,
        active: true,
      },
    });

    return NextResponse.json({ jobs, mailboxes });
  } catch (err) {
    console.error('Error fetching sync status:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'MANAGE_INTEGRATIONS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Get or create mailbox
    let mailbox = await prisma.mailbox.findFirst({
      where: { active: true },
    });

    if (!mailbox) {
      // Get email config to create mailbox
      const settings = await prisma.integrationSettings.findUnique({
        where: { type: 'ZOHO_IMAP_SMTP' },
      });

      if (!settings || !settings.enabled) {
        return NextResponse.json(
          { error: 'Email integration not configured' },
          { status: 503 }
        );
      }

      // Create mailbox from settings
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

    // Create sync job
    const job = await prisma.syncJob.create({
      data: {
        mailboxId: mailbox.id,
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });

    // Get email provider
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
      return NextResponse.json(
        { error: 'Email provider not configured' },
        { status: 503 }
      );
    }

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

      // Process new messages
      let messagesProcessed = 0;

      if (result.newMessages.length > 0) {
        // Group into threads
        const threads = emailProvider.groupIntoThreads(result.newMessages);

        // Get auto-merge settings
        const appSettings = await prisma.appSettings.findUnique({
          where: { id: 'default' },
        });
        const autoMerge = appSettings?.autoMergeThreads ?? true; // Default to true
        const mergeWindowHours = appSettings?.autoMergeWindowHours ?? 72; // Default to 72 hours

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
          if (!dbThread) {
            // If auto-merge is enabled, check for existing recent threads from same customer
            // Match by email OR by name (for cases where same person uses different emails)
            if (autoMerge && (thread.customerEmail || thread.customerName)) {
              const mergeWindowDate = new Date();
              mergeWindowDate.setHours(mergeWindowDate.getHours() - mergeWindowHours);

              // Build conditions for matching by email or name
              const matchConditions = [];
              if (thread.customerEmail) {
                // Match by email (case-insensitive)
                matchConditions.push({
                  customerEmail: {
                    equals: thread.customerEmail,
                    mode: 'insensitive' as const,
                  },
                });
              }
              if (thread.customerName && thread.customerName.trim().length >= 3) {
                // Match by name (case-insensitive) - only if name is meaningful (3+ chars)
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
                  status: { in: ['OPEN', 'PENDING'] },
                  lastMessageAt: { gte: mergeWindowDate },
                },
                orderBy: { lastMessageAt: 'desc' },
              });

              if (existingThread) {
                // Use existing thread instead of creating a new one
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
              const attachmentsWithStorage = await Promise.all(
                (msg.attachments || []).map(async (att) => {
                  // Save all attachments that have content (images, PDFs, etc.)
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

              await prisma.message.create({
                data: {
                  threadId: dbThread.id,
                  providerMessageId: msg.messageId,
                  imapUid: msg.uid,
                  direction: msg.from.address.toLowerCase() === mailbox.emailAddress.toLowerCase()
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
            }
          }

          // Update thread last message time
          await prisma.thread.update({
            where: { id: dbThread.id },
            data: {
              lastMessageAt: thread.lastMessageAt,
              // Reopen if there's a new inbound message
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
            // Get the first message body for context
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

      return NextResponse.json({
        success: true,
        messagesProcessed,
        syncState: result.syncState,
      });
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

      throw syncErr;
    } finally {
      await emailProvider.disconnect();
    }
  } catch (err) {
    console.error('Error syncing emails:', err);
    return NextResponse.json(
      { error: 'Sync failed', details: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
