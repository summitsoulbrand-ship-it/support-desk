/**
 * Thread messages API - Get messages and send replies
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { createOutboundEmailSender } from '@/lib/email';
import { validateFiles, sanitizeFilename } from '@/lib/upload-security';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureAttachmentsDir } from '@/lib/storage';

interface ParsedFormData {
  bodyHtml: string;
  bodyText?: string;
  closeOnSend?: boolean;
  originalSuggestion?: string; // For tracking AI suggestion edits
  attachments: {
    filename: string;
    mimeType: string;
    size: number;
    content: Buffer;
  }[];
}

async function parseFormData(request: NextRequest): Promise<ParsedFormData> {
  const formData = await request.formData();

  const bodyHtml = formData.get('bodyHtml');
  if (!bodyHtml || typeof bodyHtml !== 'string') {
    throw new Error('bodyHtml is required');
  }

  const bodyText = formData.get('bodyText');
  const closeOnSend = formData.get('closeOnSend') === 'true';
  const originalSuggestion = formData.get('originalSuggestion');

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
    bodyHtml,
    bodyText: typeof bodyText === 'string' ? bodyText : undefined,
    closeOnSend,
    originalSuggestion: typeof originalSuggestion === 'string' ? originalSuggestion : undefined,
    attachments,
  };
}

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

    const messages = await prisma.message.findMany({
      where: { threadId: id },
      orderBy: { sentAt: 'asc' },
      include: {
        attachments: true,
      },
    });

    return NextResponse.json(messages);
  } catch (err) {
    console.error('Error fetching messages:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'REPLY_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;

    // Parse form data (supports both JSON and multipart)
    let data: ParsedFormData;
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      data = await parseFormData(request);
    } else {
      const body = await request.json();
      data = {
        bodyHtml: body.bodyHtml,
        bodyText: body.bodyText,
        closeOnSend: body.closeOnSend,
        originalSuggestion: body.originalSuggestion,
        attachments: [],
      };
    }

    if (!data.bodyHtml) {
      return NextResponse.json(
        { error: 'bodyHtml is required' },
        { status: 400 }
      );
    }

    // Get thread with mailbox info
    const thread = await prisma.thread.findUnique({
      where: { id },
      include: {
        mailbox: true,
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!thread) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    }

    // Get outbound email sender (Resend preferred, falls back to SMTP)
    let emailSender;
    try {
      emailSender = await createOutboundEmailSender();
    } catch (providerErr) {
      console.error('Failed to create email sender:', providerErr);
      return NextResponse.json(
        {
          error: 'Email sender configuration error',
          details: providerErr instanceof Error ? providerErr.message : 'Unknown error',
        },
        { status: 503 }
      );
    }

    if (!emailSender) {
      return NextResponse.json(
        { error: 'Email sending not configured. Please configure Resend or SMTP settings in Integrations.' },
        { status: 503 }
      );
    }

    // Build threading headers
    const lastMessage = thread.messages[0];
    const inReplyTo = lastMessage?.providerMessageId || undefined;
    const references = lastMessage?.references || [];
    if (lastMessage?.providerMessageId) {
      references.push(lastMessage.providerMessageId);
    }

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

    // Create message record first (pending status)
    const pendingMessage = await prisma.message.create({
      data: {
        threadId: thread.id,
        providerMessageId: `pending-${uuidv4()}`,
        direction: 'OUTBOUND',
        status: 'PENDING',
        fromAddress: thread.mailbox.emailAddress,
        toAddresses: [thread.customerEmail],
        ccAddresses: [],
        subject: thread.subject.startsWith('Re:')
          ? thread.subject
          : `Re: ${thread.subject}`,
        bodyHtml: data.bodyHtml,
        bodyText:
          data.bodyText ||
          data.bodyHtml.replace(/<[^>]*>/g, '').substring(0, 5000),
        inReplyTo,
        references,
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

    try {
      // Send via email sender (Resend or SMTP)
      const result = await emailSender.sendMessage({
        to: [{ address: thread.customerEmail, name: thread.customerName || undefined }],
        subject: pendingMessage.subject,
        bodyHtml: data.bodyHtml,
        bodyText: pendingMessage.bodyText || undefined,
        inReplyTo,
        references,
        attachments: savedAttachments.map((att) => ({
          filename: att.filename,
          content: att.content,
          contentType: att.mimeType,
        })),
      });

      if (!result.success) {
        // Update message as failed
        await prisma.message.update({
          where: { id: pendingMessage.id },
          data: {
            status: 'FAILED',
            lastError: result.error,
            retryCount: { increment: 1 },
          },
        });

        return NextResponse.json(
          { error: 'Failed to send email', details: result.error },
          { status: 500 }
        );
      }

      // Update message as sent
      const sentMessage = await prisma.message.update({
        where: { id: pendingMessage.id },
        data: {
          providerMessageId: result.messageId,
          status: 'SENT',
        },
        include: {
          attachments: true,
        },
      });

      // Update thread
      await prisma.thread.update({
        where: { id: thread.id },
        data: {
          lastMessageAt: new Date(),
          status: data.closeOnSend ? 'CLOSED' : 'PENDING', // After reply, set to pending unless closing
        },
      });

      // Save feedback if the message was edited from an AI suggestion
      if (data.originalSuggestion) {
        const sentText = data.bodyText || data.bodyHtml.replace(/<[^>]*>/g, '').trim();
        const originalText = data.originalSuggestion.trim();

        // Only save if there was a meaningful edit (not just whitespace)
        if (sentText !== originalText) {
          try {
            // Get thread tags for categorization
            const threadTags = await prisma.threadTag.findMany({
              where: { threadId: thread.id },
              include: { tag: true },
            });

            await prisma.suggestionFeedback.create({
              data: {
                threadId: thread.id,
                originalDraft: originalText,
                editedDraft: sentText,
                threadTags: threadTags.map((tt) => tt.tag.name),
                userId: session.user.id,
              },
            });
          } catch (feedbackErr) {
            // Log but don't fail the request
            console.error('Failed to save suggestion feedback:', feedbackErr);
          }
        }
      }

      return NextResponse.json(sentMessage, { status: 201 });
    } catch (sendErr) {
      // Update message as failed
      await prisma.message.update({
        where: { id: pendingMessage.id },
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
    console.error('Error sending message:', err);
    return NextResponse.json(
      {
        error: 'Failed to send message',
        details: err instanceof Error ? err.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
