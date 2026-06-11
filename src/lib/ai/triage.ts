/**
 * AI intent triage
 * Classifies a customer thread's latest inbound message into an actionable
 * intent with extracted entities, using a cheap fast model via a forced
 * tool call (guaranteed structured output).
 */

import Anthropic from '@anthropic-ai/sdk';
import { getClaudeConfig } from '@/lib/claude';
import type { TriageIntent } from '@prisma/client';

export const TRIAGE_MODEL = 'claude-haiku-4-5-20251001';

export interface TriageEntities {
  /** Size the customer wants to receive, e.g. "L", "XL", "2XL" */
  requestedSize?: string;
  /** Size the customer currently has (exchange FROM), used to find the order */
  currentSize?: string;
  /** Color the customer wants instead, if a color change is requested */
  requestedColor?: string;
  /** Product/line item the customer refers to, verbatim-ish */
  lineItemHint?: string;
  /** Discount code the customer says they used / should have, if mentioned */
  discountCode?: string;
  /** Parsed shipping address if the customer provided a new one */
  newAddress?: {
    firstName?: string;
    lastName?: string;
    address1?: string;
    address2?: string;
    city?: string;
    region?: string;
    zip?: string;
    country?: string;
    phone?: string;
  };
  /** Customer asks to ship to the billing address already on the order */
  useBillingAddress?: boolean;
  /** Order number mentioned in the email, e.g. "#1234" */
  orderNumber?: string;
  /** Customer explicitly asks for money back (vs exchange) */
  wantsRefund?: boolean;
  /** quick sentiment read: positive | neutral | frustrated | angry */
  sentiment?: string;
}

export interface TriageResult {
  intent: TriageIntent;
  confidence: number;
  entities: TriageEntities;
  model: string;
}

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: 'classify_email',
  description: 'Record the classification of a customer service email.',
  input_schema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: [
          'SIZE_EXCHANGE',
          'SHIPPING_STATUS',
          'ADDRESS_UPDATE',
          'CANCELLATION',
          'ORDER_ISSUE',
          'RETURN_REFUND',
          'PRODUCT_QUESTION',
          'POSITIVE_FEEDBACK',
          'OTHER',
        ],
        description:
          'SIZE_EXCHANGE: wants a different size or color of an item they bought. ' +
          'SHIPPING_STATUS: asks where the order is / delivery time. ' +
          'ADDRESS_UPDATE: provides or requests a shipping address change. ' +
          'CANCELLATION: wants to cancel the order (full or partial). ' +
          'ORDER_ISSUE: received a wrong, damaged, or defective item; print or quality complaint. ' +
          'RETURN_REFUND: wants money back or to return items WITHOUT an exchange. ' +
          'PRODUCT_QUESTION: pre-sale question - sizing advice, materials, availability, shipping cost/time before buying. ' +
          'POSITIVE_FEEDBACK: thanks or praise with no NEW request - including a thank-you after their issue was already resolved earlier in the conversation. ' +
          'OTHER: anything else (newsletters, suppliers, unclear). ' +
          'IMPORTANT: classify what the LATEST message asks for. The earlier conversation is context only - if an exchange/refund/change was already handled and the latest message just acknowledges it, that is POSITIVE_FEEDBACK, not the original intent.',
      },
      confidence: {
        type: 'number',
        description: 'Confidence in the intent classification, 0 to 1',
      },
      requested_size: {
        type: 'string',
        description: 'The size the customer wants to receive instead (e.g. "L", "2XL"), if any',
      },
      current_size: {
        type: 'string',
        description: 'The size the customer currently has and wants to exchange FROM (e.g. "M"), if mentioned. Helps identify which order.',
      },
      requested_color: {
        type: 'string',
        description: 'The color the customer wants instead, if they ask for a different color (e.g. "Black", "Heather Indigo").',
      },
      line_item_hint: {
        type: 'string',
        description: 'The product the customer refers to, as mentioned in the email',
      },
      discount_code: {
        type: 'string',
        description: 'A discount/coupon code the customer says they applied or should have gotten (e.g. "WELCOME15"), if mentioned',
      },
      new_address: {
        type: 'object',
        description: 'New shipping address if the customer provided one',
        properties: {
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          address1: { type: 'string' },
          address2: { type: 'string' },
          city: { type: 'string' },
          region: { type: 'string', description: 'State/province code, e.g. CA' },
          zip: { type: 'string' },
          country: { type: 'string', description: 'Country code, e.g. US' },
          phone: { type: 'string' },
        },
      },
      use_billing_address: {
        type: 'boolean',
        description:
          'True if the customer asks to ship to the billing address already on the order ' +
          '(e.g. "please use my billing address", "send it to the billing address instead") ' +
          'rather than spelling out a new address.',
      },
      order_number: {
        type: 'string',
        description: 'Order number mentioned in the email, without the # prefix',
      },
      wants_refund: {
        type: 'boolean',
        description: 'True if the customer explicitly asks for money back rather than an exchange',
      },
      sentiment: {
        type: 'string',
        enum: ['positive', 'neutral', 'frustrated', 'angry'],
      },
    },
    required: ['intent', 'confidence'],
  },
};

const MAX_HISTORY_CHARS = 4000;

export interface TriageInput {
  subject: string;
  /** Latest inbound message body (text) */
  latestMessage: string;
  /** Older conversation context, oldest first */
  priorMessages?: { from: string; body: string }[];
}

/**
 * Classify a thread's latest inbound message. Returns null when the Claude
 * integration is not configured.
 */
export async function classifyThread(
  input: TriageInput
): Promise<TriageResult | null> {
  const config = await getClaudeConfig();
  if (!config) return null;

  const client = new Anthropic({ apiKey: config.apiKey });

  let history = '';
  if (input.priorMessages && input.priorMessages.length > 0) {
    for (const msg of input.priorMessages.slice(-6)) {
      history += `[${msg.from}]: ${msg.body}\n\n`;
    }
    if (history.length > MAX_HISTORY_CHARS) {
      history = history.slice(-MAX_HISTORY_CHARS);
    }
  }

  const userMessage =
    `Classify this customer service email for a made-to-order apparel store.\n\n` +
    `Subject: ${input.subject}\n\n` +
    (history ? `Earlier conversation:\n${history}\n` : '') +
    `Customer's latest message:\n${input.latestMessage.slice(0, MAX_HISTORY_CHARS)}`;

  const response = await client.messages.create({
    model: TRIAGE_MODEL,
    max_tokens: 1024,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: 'tool', name: 'classify_email' },
    messages: [{ role: 'user', content: userMessage }],
  });

  const toolUse = response.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === 'tool_use'
  );
  if (!toolUse) {
    throw new Error('Classifier returned no tool call');
  }

  const raw = toolUse.input as Record<string, unknown>;
  const rawAddress = raw.new_address as Record<string, string> | undefined;

  const entities: TriageEntities = {
    requestedSize: (raw.requested_size as string) || undefined,
    currentSize: (raw.current_size as string) || undefined,
    requestedColor: (raw.requested_color as string) || undefined,
    lineItemHint: (raw.line_item_hint as string) || undefined,
    discountCode: (raw.discount_code as string) || undefined,
    orderNumber: (raw.order_number as string) || undefined,
    useBillingAddress:
      typeof raw.use_billing_address === 'boolean'
        ? raw.use_billing_address
        : undefined,
    wantsRefund: typeof raw.wants_refund === 'boolean' ? raw.wants_refund : undefined,
    sentiment: (raw.sentiment as string) || undefined,
    newAddress: rawAddress
      ? {
          firstName: rawAddress.first_name || undefined,
          lastName: rawAddress.last_name || undefined,
          address1: rawAddress.address1 || undefined,
          address2: rawAddress.address2 || undefined,
          city: rawAddress.city || undefined,
          region: rawAddress.region || undefined,
          zip: rawAddress.zip || undefined,
          country: rawAddress.country || undefined,
          phone: rawAddress.phone || undefined,
        }
      : undefined,
  };

  const validIntents = new Set([
    'SIZE_EXCHANGE',
    'SHIPPING_STATUS',
    'ADDRESS_UPDATE',
    'CANCELLATION',
    'ORDER_ISSUE',
    'RETURN_REFUND',
    'PRODUCT_QUESTION',
    'POSITIVE_FEEDBACK',
    'OTHER',
  ]);
  const intent = validIntents.has(raw.intent as string)
    ? (raw.intent as TriageIntent)
    : ('OTHER' as TriageIntent);

  const confidence =
    typeof raw.confidence === 'number'
      ? Math.max(0, Math.min(1, raw.confidence))
      : 0.5;

  return { intent, confidence, entities, model: TRIAGE_MODEL };
}
