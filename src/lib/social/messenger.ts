/**
 * Messenger (page DM) sync + AI drafts
 * Pulls the page's Messenger conversations and messages into the DB and
 * pre-writes replies for conversations awaiting a response, so the VA handles
 * DMs from the tool without logging into Facebook.
 *
 * Meta policy: pages may send standard (RESPONSE) messages only within 24
 * hours of the user's last message. The reply API route enforces that window.
 */

import Anthropic from '@anthropic-ai/sdk';
import prisma from '@/lib/db';
import { getSocialKnowledgeText } from './knowledge';
import { getClaudeConfig } from '@/lib/claude';
import {
  COMPANY_IDENTITY,
  BRAND_VOICE_GUIDELINES,
  STORE_POLICY_FACTS,
  ISSUE_HANDLING_RULES,
  withOperatorInstructions,
} from '@/lib/claude/brand-voice';
import { createMetaClient } from './meta-client';

const DM_DRAFT_MODEL = process.env.DM_DRAFT_MODEL || 'claude-opus-4-8';
const DRAFT_BATCH = 5;

export const MESSENGER_WINDOW_MS = 24 * 60 * 60 * 1000;

const DM_SYSTEM_PROMPT = `You are the customer service voice of Summit Soul. ${COMPANY_IDENTITY} You draft PRIVATE Messenger replies - a 1:1 conversation, not public. Use the exact same voice as the brand's customer service emails.

${BRAND_VOICE_GUIDELINES}

${STORE_POLICY_FACTS}

${ISSUE_HANDLING_RULES}

## Messenger format (this channel only)
- Short: 1-4 sentences. Messenger is conversational - no greeting line, no email signature.
- 0-1 emoji max.

## Rules
1. Answer the customer's question directly when the conversation gives you enough to go on.
2. For order issues that need the order pulled up (shipping status, exchange, refund, address change), ask them to email support@summitsoul.shop with their order number so the team can look it up - do NOT invent order details, you have no order data here. For a fit or wrong-size complaint you may ask for the photo described above right here in the chat first, then have them email so we can match it to the order.
3. Never promise specific refunds, replacements, or delivery dates.
4. If they ask about products, you may mention the store at summitsoul.shop.

Output ONLY the message text.`;

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
 * Re-fetch the FULL message history for ONE conversation and store it.
 * Used on-demand when an agent opens a DM, so a quiet thread the background
 * sync skipped still shows every message (the upsert never deletes). Returns
 * how many messages are now stored, or null if it couldn't fetch / was
 * throttled.
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

  const messages = await client.getConversationMessages(conv.externalId, 200);
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

        // Pull messages (newest first from the API). Fetch a deep page so
        // longer threads keep their full history - the upsert below never
        // deletes, so this also backfills older messages we missed earlier.
        const messages = await client.getConversationMessages(conv.id, 200);
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
    const config = await getClaudeConfig();
    if (config) {
      const claude = new Anthropic({ apiKey: config.apiKey });

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

          const response = await claude.messages.create({
            model: DM_DRAFT_MODEL,
            max_tokens: 300,
            system:
              withOperatorInstructions(DM_SYSTEM_PROMPT, config.customPrompt) +
              (await getSocialKnowledgeText()),
            messages: [
              {
                role: 'user',
                content: `Conversation so far:\n${transcript.slice(-3000)}\n\nWrite the brand's next reply.`,
              },
            ],
          });

          const text = response.content.find((c) => c.type === 'text');
          if (!text || text.type !== 'text') throw new Error('No text in response');

          await prisma.socialConversation.update({
            where: { id: conv.id },
            data: {
              aiDraft: text.text.trim().replace(/\s*[—–]\s*/g, ' - '),
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
