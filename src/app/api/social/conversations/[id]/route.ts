/**
 * Messenger conversation detail + reply
 * Reply enforces Meta's 24-hour standard messaging window: pages may only
 * send a RESPONSE message within 24h of the customer's last message.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { createMetaClient } from '@/lib/social/meta-client';
import {
  isWithinMessagingWindow,
  refreshConversationMessages,
} from '@/lib/social/messenger';

type RouteContext = {
  params: Promise<{ id: string }>;
};

const actionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('reply'),
    message: z.string().min(1).max(2000),
  }),
]);

const updateSchema = z.object({
  status: z.enum(['NEW', 'IN_PROGRESS', 'DONE', 'ESCALATED']).optional(),
});

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;

    // Opening a DM pulls its full history live from Meta (on-demand), so a
    // quiet thread the background sync skipped still shows every message.
    // Best-effort - never block the read on a Meta hiccup.
    await refreshConversationMessages(id).catch((err) =>
      console.error('On-open message refresh failed:', err)
    );

    const conversation = await prisma.socialConversation.findUnique({
      where: { id },
      include: {
        account: { select: { name: true, externalId: true } },
        messages: { orderBy: { sentAt: 'asc' } },
      },
    });
    if (!conversation) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json({
      conversation,
      withinWindow: isWithinMessagingWindow(conversation.lastCustomerMessageAt),
    });
  } catch (err) {
    console.error('Error fetching conversation:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
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
    const actionData = actionSchema.parse(await request.json());

    const conversation = await prisma.socialConversation.findUnique({
      where: { id },
      include: { account: true },
    });
    if (!conversation) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    if (!conversation.participantId) {
      return NextResponse.json(
        { error: 'No recipient id on this conversation - resync and try again' },
        { status: 400 }
      );
    }

    // Meta 24h standard messaging window (policy, enforced server-side)
    if (!isWithinMessagingWindow(conversation.lastCustomerMessageAt)) {
      return NextResponse.json(
        {
          error:
            "Meta's 24-hour messaging window has closed for this conversation. " +
            'Pages can only send standard replies within 24 hours of the ' +
            "customer's last message. If they message again, the window reopens.",
        },
        { status: 403 }
      );
    }

    const client = await createMetaClient(conversation.account.externalId);
    if (!client) {
      return NextResponse.json({ error: 'Meta not connected' }, { status: 503 });
    }

    const result = await client.sendMessengerMessage(
      conversation.participantId,
      actionData.message
    );

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || 'Failed to send message' },
        { status: 500 }
      );
    }

    // Record our own message locally and resolve the conversation
    const sentAt = new Date();
    await prisma.socialMessage.create({
      data: {
        conversationId: conversation.id,
        externalId:
          (result.data as { message_id?: string })?.message_id ||
          `local-${conversation.id}-${sentAt.getTime()}`,
        fromId: conversation.account.externalId,
        fromName: conversation.account.name,
        isPage: true,
        message: actionData.message,
        sentAt,
      },
    });
    await prisma.socialConversation.update({
      where: { id },
      data: {
        status: 'DONE',
        snippet: actionData.message.slice(0, 120),
        lastMessageAt: sentAt,
        aiDraft: null,
        aiDraftAt: null,
      },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request', details: err.issues },
        { status: 400 }
      );
    }
    console.error('Error replying to conversation:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!hasPermission(session.user.role, 'REPLY_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;
    const data = updateSchema.parse(await request.json());

    const conversation = await prisma.socialConversation.update({
      where: { id },
      data,
    });

    return NextResponse.json({ conversation });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request', details: err.issues },
        { status: 400 }
      );
    }
    console.error('Error updating conversation:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
