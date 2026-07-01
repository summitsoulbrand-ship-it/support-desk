/**
 * Messenger (page DM) sync + AI drafts
 * Pulls the page's Messenger conversations and messages into the DB and
 * pre-writes replies for conversations awaiting a response, so the VA handles
 * DMs from the tool without logging into Facebook.
 *
 * Meta policy: pages may send standard (RESPONSE) messages only within 24
 * hours of the user's last message. The reply API route enforces that window.
 */

import prisma from '@/lib/db';
import { getSocialKnowledgeText } from './knowledge';
import { createClaudeService } from '@/lib/claude';
import { createMetaClient } from './meta-client';

const DM_DRAFT_MODEL = process.env.DM_DRAFT_MODEL || 'claude-opus-4-8';
const DRAFT_BATCH = 5;

export const MESSENGER_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface MessengerSyncStats {
  conversations: number;
  newMessages: number;
  drafted: number;
  errors: number;
}

// Throttle on-open refreshes so the detail view's 30s polling can't hammer
// Meta - one live fetch per conversation per minute is plenty.
const lastMsgRefresh = new Map<string, number>();
const MSG_REFRESH_THROTTLE_MS = 60_000;

/**
 * Refresh ONE conversation's messages on-demand (when an agent opens a DM),
 * so a quiet thread the background sync skipped still shows every message.
 * Incremental: only fetches messages newer than the latest one we already
 * have, so an unchanged thread costs a single short Meta call and stores
 * nothing new. Returns how many messages were fetched, or null if it couldn't
 * fetch / was throttled.
 */
export async function refreshConversationMessages(
  conversationId: string
): Promise<number | null> {
  const last = lastMsgRefresh.get(conversationId);
  if (last && Date.now() - last < MSG_REFRESH_THROTTLE_MS) return null;
  lastMsgRefresh.set(conversationId, Date.now());

  const conv = await prisma.socialConversation.findUnique({
    where: { id: conversationId },
    include: { account: true },
  });
  if (!conv) return null;

  const client = await createMetaClient(conv.account.externalId);
  if (!client) return null;

  // Only pull messages newer than the newest we already hold (full pull the
  // first time, when there's nothing stored yet).
  const newest = await prisma.socialMessage.findFirst({
    where: { conversationId: conv.id },
    orderBy: { sentAt: 'desc' },
    select: { sentAt: true },
  });
  const messages = await client.getConversationMessages(
    conv.externalId,
    200,
    newest ? { newerThan: newest.sentAt } : undefined
  );
  for (const msg of messages) {
    const isPage = msg.from?.id === conv.account.externalId;
    await prisma.socialMessage.upsert({
      where: { externalId: msg.id },
      create: {
        conversationId: conv.id,
        externalId: msg.id,
        fromId: msg.from?.id || null,
        fromName: msg.from?.name || null,
        isPage,
        message: msg.message || '',
        attachments: msg.attachments
          ? JSON.parse(JSON.stringify(msg.attachments.data))
          : undefined,
        sentAt: new Date(msg.created_time),
      },
      update: {},
    });
  }
  return messages.length;
}

/**
 * Sync Messenger conversations for all enabled Facebook page accounts, then
 * draft replies for conversations whose latest message is from the customer.
 */
export async function syncMessengerAndDraft(): Promise<MessengerSyncStats> {
  const stats: MessengerSyncStats = {
    conversations: 0,
    newMessages: 0,
    drafted: 0,
    errors: 0,
  };

  const accounts = await prisma.socialAccount.findMany({
    where: { enabled: true, platform: 'FACEBOOK' },
  });

  for (const account of accounts) {
    try {
      const client = await createMetaClient(account.externalId);
      if (!client) continue;

      const conversations = await client.getConversations(account.externalId, 25);
      stats.conversations += conversations.length;

      for (const conv of conversations) {
        // Skip threads with no activity since the last successful sync -
        // Meta bumps updated_time on every new message, and lastMessageAt is
        // only advanced after a thread's messages are stored, so an unchanged
        // updated_time means there is nothing new to fetch.
        const updatedTime = new Date(conv.updated_time);
        const existing = await prisma.socialConversation.findUnique({
          where: {
            accountId_externalId: { accountId: account.id, externalId: conv.id },
          },
          select: { lastMessageAt: true },
        });
        if (existing && existing.lastMessageAt.getTime() >= updatedTime.getTime()) {
          continue;
        }

        // The customer is the participant that isn't the page itself
        const other = conv.participants?.data?.find(
          (p) => p.id !== account.externalId
        );

        const dbConv = await prisma.socialConversation.upsert({
          where: {
            accountId_externalId: { accountId: account.id, externalId: conv.id },
          },
          create: {
            accountId: account.id,
            externalId: conv.id,
            participantId: other?.id || null,
            participantName: other?.name || 'Customer',
            snippet: conv.snippet || null,
            unreadCount: conv.unread_count || 0,
            canReply: conv.can_reply ?? true,
            // Epoch placeholder: the real value is set below, after this
            // thread's messages are stored, so a failed fetch retries next pass
            lastMessageAt: new Date(0),
          },
          update: {
            participantId: other?.id || undefined,
            participantName: other?.name || undefined,
            snippet: conv.snippet || null,
            unreadCount: conv.unread_count || 0,
            canReply: conv.can_reply ?? true,
          },
        });

        // Pull messages newest-first, but only the ones newer than what we
        // already hold (full pull the first time). Keeps long threads complete
        // without re-downloading the whole history every sync.
        const newestStored = await prisma.socialMessage.findFirst({
          where: { conversationId: dbConv.id },
          orderBy: { sentAt: 'desc' },
          select: { sentAt: true },
        });
        const messages = await client.getConversationMessages(
          conv.id,
          200,
          newestStored ? { newerThan: newestStored.sentAt } : undefined
        );
        let newInThisConv = 0;

        for (const msg of messages) {
          const isPage = msg.from?.id === account.externalId;
          const created = await prisma.socialMessage.upsert({
            where: { externalId: msg.id },
            create: {
              conversationId: dbConv.id,
              externalId: msg.id,
              fromId: msg.from?.id || null,
              fromName: msg.from?.name || null,
              isPage,
              message: msg.message || '',
              attachments: msg.attachments
                ? JSON.parse(JSON.stringify(msg.attachments.data))
                : undefined,
              sentAt: new Date(msg.created_time),
            },
            update: {},
          });
          if (created.createdAt.getTime() > Date.now() - 60_000) newInThisConv++;
        }
        stats.newMessages += newInThisConv;

        // Recompute conversation state from the messages we hold
        const latest = await prisma.socialMessage.findFirst({
          where: { conversationId: dbConv.id },
          orderBy: { sentAt: 'desc' },
        });
        const latestCustomer = await prisma.socialMessage.findFirst({
          where: { conversationId: dbConv.id, isPage: false },
          orderBy: { sentAt: 'desc' },
        });

        const awaitingReply = !!latest && !latest.isPage;
        await prisma.socialConversation.update({
          where: { id: dbConv.id },
          data: {
            // Messages stored - safe to mark the thread as synced through
            // Meta's updated_time so future passes can skip it
            lastMessageAt: updatedTime,
            lastCustomerMessageAt: latestCustomer?.sentAt || null,
            // New customer message invalidates an old draft + reopens
            ...(awaitingReply && dbConv.status === 'DONE'
              ? { status: 'NEW' }
              : {}),
            ...(awaitingReply &&
            dbConv.aiDraftAt &&
            latestCustomer &&
            dbConv.aiDraftAt < latestCustomer.sentAt
              ? { aiDraft: null, aiDraftAt: null }
              : {}),
          },
        });
      }
    } catch (err) {
      stats.errors++;
      console.error(
        `[Messenger] Sync failed for ${account.name}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // ---- Draft replies for conversations awaiting a response ----
  const needingDrafts = await prisma.socialConversation.findMany({
    where: {
      status: { in: ['NEW', 'IN_PROGRESS'] },
      aiDraft: null,
      canReply: true,
      lastCustomerMessageAt: { not: null },
    },
    orderBy: { lastMessageAt: 'desc' },
    take: DRAFT_BATCH,
    include: {
      messages: { orderBy: { sentAt: 'desc' }, take: 12 },
    },
  });

  if (needingDrafts.length > 0) {
    // All AI drafting goes through the shared ClaudeService (messenger
    // channel), so this path gets the same brand-voice prompt composition,
    // retired-model normalization, and reply cleanup as the other channels.
    const claude = await createClaudeService();
    if (claude) {
      // The knowledge block is identical across the batch - fetch it once.
      const knowledgeText = await getSocialKnowledgeText();

      for (const conv of needingDrafts) {
        // Only draft when the customer spoke last
        const newestFirst = conv.messages;
        if (newestFirst.length === 0 || newestFirst[0].isPage) continue;

        try {
          const transcript = [...newestFirst]
            .reverse()
            .map(
              (m) =>
                `${m.isPage ? 'Summit Soul' : conv.participantName}: ${m.message || '(attachment)'}`
            )
            .join('\n');

          const draft = await claude.generateMessengerReply(
            `Conversation so far:\n${transcript.slice(-3000)}\n\nWrite the brand's next reply.`,
            {
              model: DM_DRAFT_MODEL,
              maxTokens: 300,
              knowledgeText,
            }
          );

          await prisma.socialConversation.update({
            where: { id: conv.id },
            data: {
              aiDraft: draft,
              aiDraftAt: new Date(),
            },
          });
          stats.drafted++;
        } catch (err) {
          stats.errors++;
          console.error(
            `[Messenger] Draft failed for conversation ${conv.id}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    }
  }

  return stats;
}

/** True when Meta's 24h standard messaging window is still open. */
export function isWithinMessagingWindow(lastCustomerMessageAt: Date | null): boolean {
  if (!lastCustomerMessageAt) return false;
  return Date.now() - lastCustomerMessageAt.getTime() < MESSENGER_WINDOW_MS;
}
