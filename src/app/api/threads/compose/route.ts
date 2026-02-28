/**
 * Compose API - Create new email threads
 * POST: Create a new thread and send the initial email
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { createOutboundEmailSender } from '@/lib/email';
import { validateFiles, sanitizeFilename } from '@/lib/upload-security';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ensureAttachmentsDir } from '@/lib/storage';

const composeSchema = z.object({
  to: z.string().email(),
  toName: z.string().optional(),
  subject: z.string().min(1),
  bodyHtml: z.string().min(1),
  bodyText: z.string().optional(),
});

interface ParsedFormData {
  to: string;
  toName?: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  attachments: {
    filename: string;
    mimeType: string;
    size: number;
    content: Buffer;
  }[];
}

async function parseFormData(request: NextRequest): Promise<ParsedFormData> {
  const formData = await request.formData();

  const to = formData.get('to');
  const toName = formData.get('toName');
  const subject = formData.get('subject');
  const bodyHtml = formData.get('bodyHtml');
  const bodyText = formData.get('bodyText');

  if (!to || typeof to !== 'string') {
    throw new Error('to is required');
  }
  if (!subject || typeof subject !== 'string') {
    throw new Error('subject is required');
  }
  if (!bodyHtml || typeof bodyHtml !== 'string') {
    throw new Error('bodyHtml is required');
  }

  const attachments: ParsedFormData['attachments'] = [];
  const files = formData.getAll('attachments');

  for (const file of files) {
    if (file instanceof File) {
      const buffer = Buffer.from(await file.arrayBuffer());
      attachments.push({
        filename: sanitizeFilename(file.name),
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        content: buffer,
      });
    }
  }

  // Validate files for security
  if (attachments.length > 0) {
    const validation = validateFiles(attachments);
    if (!validation.valid) {
      throw new Error(validation.error);
    }
  }

  return {
    to,
    toName: typeof toName === 'string' ? toName : undefined,
    subject,
    bodyHtml,
    bodyText: typeof bodyText === 'string' ? bodyText : undefined,
    attachments,
  };
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'REPLY_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Parse form data (supports both JSON and multipart)
    let data: ParsedFormData;
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      data = await parseFormData(request);
      console.log('[Compose] Parsed form data - to:', data.to, 'subject:', data.subject);
    } else {
      const body = await request.json();
      const parsed = composeSchema.parse(body);
      data = {
        ...parsed,
        attachments: [],
      };
    }

    // Get outbound email sender (Zoho API > Resend > SMTP)
    const emailSender = await createOutboundEmailSender();
    if (!emailSender) {
      return NextResponse.json(
        { error: 'Email sending not configured. Please configure Zoho Mail API, Resend, or SMTP settings in Integrations.' },
        { status: 503 }
      );
    }

    // Get the mailbox (we need one to send from)
    const mailbox = await prisma.mailbox.findFirst({
      where: { active: true },
    });

    if (!mailbox) {
      return NextResponse.json(
        { error: 'No active mailbox configured' },
        { status: 503 }
      );
    }

    // Generate a unique thread key for this new conversation
    const threadKey = `compose-${uuidv4()}`;

    // Save attachments to disk
    const savedAttachments: {
      filename: string;
      mimeType: string;
      size: number;
      storagePath: string;
      content: Buffer;
    }[] = [];

    if (data.attachments.length > 0) {
      const dir = await ensureAttachmentsDir();

      for (const att of data.attachments) {
        const ext = path.extname(att.filename) || '.bin';
        const fileName = `${uuidv4()}${ext}`;
        const filePath = path.join(dir, fileName);

        await fs.writeFile(filePath, att.content);

        savedAttachments.push({
          filename: att.filename,
          mimeType: att.mimeType,
          size: att.size,
          storagePath: filePath,
          content: att.content,
        });
      }
    }

    // Create the thread and message in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Ensure CustomerLink exists (required by foreign key constraint)
      // CustomerLink only stores email and Shopify data - name is on Thread
      await tx.customerLink.upsert({
        where: { email: data.to },
        update: {},
        create: {
          email: data.to,
        },
      });

      // Create the thread
      const thread = await tx.thread.create({
        data: {
          mailboxId: mailbox.id,
          providerThreadKey: threadKey,
          subject: data.subject,
          customerEmail: data.to,
          customerName: data.toName || null,
          status: 'PENDING', // We sent a message, waiting for response
          lastMessageAt: new Date(),
        },
      });

      // Create the message (pending status)
      const message = await tx.message.create({
        data: {
          threadId: thread.id,
          providerMessageId: `pending-${uuidv4()}`,
          direction: 'OUTBOUND',
          status: 'PENDING',
          fromAddress: mailbox.emailAddress,
          toAddresses: [data.to],
          ccAddresses: [],
          subject: data.subject,
          bodyHtml: data.bodyHtml,
          bodyText:
            data.bodyText ||
            data.bodyHtml.replace(/<[^>]*>/g, '').substring(0, 5000),
          sentAt: new Date(),
          attachments: {
            create: savedAttachments.map((att) => ({
              filename: att.filename,
              mimeType: att.mimeType,
              size: att.size,
              storagePath: att.storagePath,
            })),
          },
        },
        include: {
          attachments: true,
        },
      });

      return { thread, message };
    });

    try {
      // Send via outbound email sender
      console.log('[Compose] Sending email to:', data.to, 'name:', data.toName);
      const sendResult = await emailSender.sendMessage({
        to: [{ address: data.to, name: data.toName }],
        subject: data.subject,
        bodyHtml: data.bodyHtml,
        bodyText: result.message.bodyText || undefined,
        attachments: savedAttachments.map((att) => ({
          filename: att.filename,
          content: att.content,
          contentType: att.mimeType,
        })),
      });

      if (!sendResult.success) {
        // Update message as failed
        await prisma.message.update({
          where: { id: result.message.id },
          data: {
            status: 'FAILED',
            lastError: sendResult.error,
            retryCount: { increment: 1 },
          },
        });

        return NextResponse.json(
          { error: 'Failed to send email', details: sendResult.error },
          { status: 500 }
        );
      }

      // Update message as sent
      await prisma.message.update({
        where: { id: result.message.id },
        data: {
          providerMessageId: sendResult.messageId,
          status: 'SENT',
        },
      });

      return NextResponse.json(
        {
          thread: result.thread,
          message: { ...result.message, status: 'SENT' },
        },
        { status: 201 }
      );
    } catch (sendErr) {
      // Update message as failed
      await prisma.message.update({
        where: { id: result.message.id },
        data: {
          status: 'FAILED',
          lastError:
            sendErr instanceof Error ? sendErr.message : 'Unknown error',
          retryCount: { increment: 1 },
        },
      });

      throw sendErr;
    } finally {
      await emailSender.disconnect();
    }
  } catch (err) {
    console.error('Error composing email:', err);
    console.error('Error stack:', err instanceof Error ? err.stack : 'No stack');
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request', details: err.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
