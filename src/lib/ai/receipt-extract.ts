/**
 * Read an order reference off a receipt the customer attached.
 *
 * Last-resort order matching: when we can't find the order by the sender's
 * email or name, but they attached their order confirmation / receipt (PDF or
 * image), read it to pull out the order number (and the email it was placed
 * under). Cheap vision model, and only runs when nothing else matched.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getClaudeConfig } from '@/lib/claude';
import prisma from '@/lib/db';
import { createShopifyClient } from '@/lib/shopify';
import type { ShopifyOrder } from '@/lib/shopify/types';

const EXTRACT_MODEL =
  process.env.RECEIPT_EXTRACT_MODEL || 'claude-haiku-4-5-20251001';

export interface ReceiptAttachment {
  mimeType: string;
  /** base64-encoded file bytes */
  base64: string;
}

export interface ReceiptOrderRef {
  orderNumber?: string; // without the leading '#'
  email?: string;
}

const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'record_order_ref',
  description:
    'Record the order number and customer email found on an attached order receipt or confirmation.',
  input_schema: {
    type: 'object',
    properties: {
      order_number: {
        type: 'string',
        description:
          'The store order number exactly as printed (digits only, no # or other prefixes). Omit if not clearly present.',
      },
      email: {
        type: 'string',
        description: 'The customer email shown on the receipt, if any.',
      },
      found: {
        type: 'boolean',
        description: 'True only if this really is an order receipt/confirmation.',
      },
    },
    required: ['found'],
  },
};

export async function extractOrderRefFromReceipt(
  attachments: ReceiptAttachment[]
): Promise<ReceiptOrderRef | null> {
  if (attachments.length === 0) return null;
  const config = await getClaudeConfig();
  if (!config) return null;

  const blocks: Anthropic.ContentBlockParam[] = attachments
    .slice(0, 2) // never send more than two files
    .map((a) => {
      if (a.mimeType === 'application/pdf') {
        return {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: a.base64 },
        } as Anthropic.ContentBlockParam;
      }
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: a.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: a.base64,
        },
      } as Anthropic.ContentBlockParam;
    });

  blocks.push({
    type: 'text',
    text: 'This is attached to a customer support email. If it is an order receipt or confirmation, record the store order number and the customer email.',
  });

  try {
    const client = new Anthropic({ apiKey: config.apiKey });
    const response = await client.messages.create({
      model: EXTRACT_MODEL,
      max_tokens: 300,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'record_order_ref' },
      messages: [{ role: 'user', content: blocks }],
    });
    const toolUse = response.content.find(
      (c): c is Anthropic.ToolUseBlock => c.type === 'tool_use'
    );
    if (!toolUse) return null;
    const input = toolUse.input as {
      order_number?: string;
      email?: string;
      found?: boolean;
    };
    if (!input.found) return null;
    const orderNumber = input.order_number?.replace(/[^0-9]/g, '') || undefined;
    return { orderNumber, email: input.email?.trim() || undefined };
  } catch (err) {
    console.error('[receipt-extract] failed:', err);
    return null;
  }
}

/**
 * Resolve an order from a receipt attached to the thread's latest inbound
 * message. Shared by the draft pipeline and the sidebar context route. The
 * extracted order number is cached on the triage row, so the vision call runs
 * at most once per thread no matter which path hits it first. Returns the
 * matched order(s), or null if there's no receipt / no match.
 */
export async function resolveReceiptOrder(opts: {
  threadId: string;
  latestInboundMessageId: string;
  triageEntities: Record<string, unknown> | null;
  hasTriageRow: boolean;
}): Promise<{ orders: ShopifyOrder[]; orderNumber: string } | null> {
  const entities = opts.triageEntities || {};
  let receiptOrderNumber = entities.receiptOrderNumber as string | undefined;

  if (!receiptOrderNumber && entities.receiptChecked !== true) {
    const atts = await prisma.attachment.findMany({
      where: {
        messageId: opts.latestInboundMessageId,
        mimeType: {
          in: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'],
        },
        content: { not: null },
      },
      select: { mimeType: true, content: true },
      take: 2,
    });
    if (atts.length > 0) {
      const ref = await extractOrderRefFromReceipt(
        atts
          .filter((a) => a.content)
          .map((a) => ({
            mimeType: a.mimeType,
            base64: Buffer.from(a.content as Buffer).toString('base64'),
          }))
      );
      receiptOrderNumber = ref?.orderNumber;
    }
    if (opts.hasTriageRow) {
      await prisma.threadTriage
        .update({
          where: { threadId: opts.threadId },
          data: {
            entities: {
              ...entities,
              receiptChecked: true,
              ...(receiptOrderNumber ? { receiptOrderNumber } : {}),
            },
          },
        })
        .catch(() => undefined);
    }
  }

  if (!receiptOrderNumber) return null;

  const shopifyClient = await createShopifyClient();
  if (!shopifyClient) return null;
  const orders = await shopifyClient.getOrdersByQuery(`name:#${receiptOrderNumber}`, 5);
  const order =
    orders.find((o) => o.name.replace('#', '') === receiptOrderNumber) || orders[0];
  return order ? { orders: [order], orderNumber: receiptOrderNumber } : null;
}
