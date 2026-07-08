/**
 * AI intent triage
 * Classifies a customer thread's latest inbound message into an actionable
 * intent with extracted entities, using a cheap fast model via a forced
 * tool call (guaranteed structured output).
 */

import Anthropic from '@anthropic-ai/sdk';
import { getClaudeConfig } from '@/lib/claude';
import type { TriageIntent } from '@prisma/client';
import { isUnsubscribeText } from '@/lib/unsubscribe-detect';

export const TRIAGE_MODEL = 'claude-haiku-4-5-20251001';

export interface TriageEntities {
  /** Size the customer wants to receive, e.g. "L", "XL", "2XL" */
  requestedSize?: string;
  /** Size the customer currently has (exchange FROM), used to find the order */
  currentSize?: string;
  /** Customer wants bigger/smaller without naming a size ("need a larger one") */
  sizeDirection?: 'up' | 'down';
  /** Color the customer wants instead, if a color change is requested */
  requestedColor?: string;
  /** Product/line item the customer refers to, verbatim-ish */
  lineItemHint?: string;
  /**
   * Every item the customer wants to exchange, one entry each. Set when the
   * request covers one OR MORE specific items (e.g. two emails about the same
   * order, each exchanging a different shirt). The single fields above stay
   * populated for the primary item for backward compatibility.
   */
  exchangeItems?: {
    itemHint?: string;
    currentSize?: string;
    requestedSize?: string;
    sizeDirection?: 'up' | 'down';
    requestedColor?: string;
  }[];
  /**
   * "All the others in 3XL - Walking with Legends fits fine": the customer
   * exchanges EVERY item on the order except the ones hinted in keepHints.
   * The classifier reads only the email, so it can't name items the customer
   * didn't - it must NOT fabricate placeholder exchangeItems entries;
   * consumers resolve this against the actual order line items instead.
   */
  exchangeAllExcept?: {
    keepHints: string[];
    requestedSize?: string;
    sizeDirection?: 'up' | 'down';
    requestedColor?: string;
  };
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
          'DISCOUNT',
          'PRODUCT_QUESTION',
          'POSITIVE_FEEDBACK',
          'UNSUBSCRIBE',
          'WHOLESALE',
          'SPAM',
          'OTHER',
        ],
        description:
          'SIZE_EXCHANGE: wants a different size or color of an item they bought. This INCLUDES a fit complaint about an item they already own ("this is too small / too tight / does not fit", "the medium runs small") even when they have not yet named the replacement size - do NOT put fit complaints in OTHER. ' +
          'SHIPPING_STATUS: asks where the order is / delivery time, OR says a package never arrived / is lost / is missing / shows delivered but they do not have it - all of these are SHIPPING_STATUS, never OTHER. ' +
          'ADDRESS_UPDATE: provides or requests a shipping address change. ' +
          'CANCELLATION: wants to cancel the order (full or partial). ' +
          'ORDER_ISSUE: received a wrong, damaged, or defective PHYSICAL item; print or quality complaint (a hole, misprint, stain, faint/hard-to-read print, smell, wrong item shipped). This is about the GOODS being wrong, NOT about pricing. This INCLUDES a message that DESCRIBES such a defect even if a replacement was already sent and the customer is also thanking you - the defect report is product feedback that must be surfaced, so it is ORDER_ISSUE, not POSITIVE_FEEDBACK. ' +
          'RETURN_REFUND: wants money back or to return items WITHOUT an exchange. ' +
          'DISCOUNT: a discount, promo, or coupon code did not apply or seems to have calculated wrong, or the customer thinks they were overcharged because a discount was missed ("I don\'t think it calculated my discount", "my code didn\'t work", "I should have gotten 15% off", "the sale price wasn\'t applied"). Classify these as DISCOUNT, never ORDER_ISSUE. ' +
          'PRODUCT_QUESTION: pre-sale question - sizing advice, materials, availability, shipping cost/time before buying. This ALSO covers a customer trying to find or buy a specific design they saw or remember ("do you still have the alien and Sasquatch shirt?", "where is the Dawn Patrol tee I saw advertised?") - a product-hunt is PRODUCT_QUESTION, not OTHER. ' +
          'POSITIVE_FEEDBACK: ONLY thanks or praise with NO actionable request of any kind (literally nothing to do but acknowledge), including a pure thank-you after their issue was already resolved earlier. A warm, polite, or grateful tone does NOT make a message feedback: if it ALSO asks for or reports something that needs action - a size/color exchange, a defect or wrong/missing/damaged item, an address change, a refund or cancellation, a shipping question, or any other request - classify it by that ACTION, never POSITIVE_FEEDBACK. When in doubt between POSITIVE_FEEDBACK and an action intent, choose the action. ' +
          'CRITICAL - a reply that ANSWERS a question WE asked is NOT feedback: if we asked the customer for information needed to proceed (which size or color to make, to confirm an address or a design, to pick an option) and their reply PROVIDES that answer - even briefly and even wrapped in gratitude like "Wonderful, thank you so much! A Medium would be great!" - it is actionable and must be classified by what the answer is about: a named size and/or color = SIZE_EXCHANGE (put the size in requested_size / color in requested_color), an address = ADDRESS_UPDATE, otherwise OTHER. NEVER POSITIVE_FEEDBACK, because we still owe them a reply/action. Signals that we asked a question: a subject that begins with "Re:" on a question we sent (e.g. "Re: Quick question while we make your order"), or prior history showing our question. ' +
          'UNSUBSCRIBE: asks to be removed from the email list or to stop receiving emails - "unsubscribe", "STOP", "take me off your list", "remove me", "stop emailing me", or similar. ' +
          'WHOLESALE: a wholesale, bulk, reseller, or large-quantity purchase inquiry ("do you offer wholesale?", "I run a shop and want to carry these", "pricing for 50 shirts", "bulk order for my rock club"). ' +
          'SPAM: NOT a customer - vendor/SaaS marketing (e.g. Zoho, Meta, Higgsfield, Klaviyo promos), an SEO/marketing/agency/partnership pitch ("boost your sales", "3% service partnership", "I noticed issues with your site"), a job/application pitch, or an internal automated system notification. These get NO reply draft, so use SPAM rather than OTHER for them. ' +
          'OTHER: a genuine customer message that truly fits none of the above (rare). Do NOT use OTHER for fit complaints, lost packages, product-hunts, wholesale, or vendor/marketing mail - those have their own intents above. ' +
          'IMPORTANT: classify what the LATEST message asks for. The earlier conversation is context only - if an exchange/refund/change was already handled and the latest message just acknowledges it, that is POSITIVE_FEEDBACK, not the original intent. EXCEPTION 1: if that acknowledgment also DESCRIBES a product defect or quality problem (the print was barely visible, a misprint, a smell, poor quality) - even gratefully and even though the replacement already shipped - classify it ORDER_ISSUE so the defect is surfaced, not POSITIVE_FEEDBACK. EXCEPTION 2: if the latest message ANSWERS a still-open question we asked (a size/color to make, an address or design to confirm) rather than just acknowledging finished work, it is actionable - classify it by that answer (SIZE_EXCHANGE / ADDRESS_UPDATE / OTHER), not POSITIVE_FEEDBACK. ' +
          'EXCEPTION for size/color exchanges: a customer may send SEPARATE emails for the same order, each asking to exchange a DIFFERENT item. When the intent is SIZE_EXCHANGE, do NOT treat the earlier emails as mere context - gather EVERY item the customer asked to exchange across ALL of their emails in this thread into exchange_items (one entry per item). Missing one of the items is a failure.',
      },
      confidence: {
        type: 'number',
        description: 'Confidence in the intent classification, 0 to 1',
      },
      requested_size: {
        type: 'string',
        description:
          'The size the customer wants to receive instead (e.g. "L", "2XL"), if any. ' +
          'Fill this in even when they ALSO ask for a different color - a request can change both size and color at once. ' +
          'OMIT this field entirely when no exact size is named ("one size up" = size_direction only) - NEVER output placeholder values like "UNKNOWN" or "N/A".',
      },
      current_size: {
        type: 'string',
        description: 'The size the customer currently has and wants to exchange FROM (e.g. "M"), if mentioned. Helps identify which order.',
      },
      size_direction: {
        type: 'string',
        enum: ['up', 'down'],
        description:
          'When the customer asks for a bigger or smaller size WITHOUT naming one ' +
          '("it is too small, how do I get a larger size" = up; "too big, need smaller" = down). ' +
          'Omit when they name the exact size they want.',
      },
      requested_color: {
        type: 'string',
        description:
          'A DIFFERENT color the customer wants instead of the one they have (e.g. "change it to Black"). ' +
          'Capture a size change and a color change independently. ' +
          'CRITICAL: do NOT set this when the customer is merely DESCRIBING the color of the item they already own - e.g. "the yellow medium is too small, I need a large" is describing their yellow shirt, NOT requesting a color change (leave requested_color empty there). Only set it when they clearly want a new/different color.',
      },
      line_item_hint: {
        type: 'string',
        description: 'The product the customer refers to, as mentioned in the email',
      },
      exchange_items: {
        type: 'array',
        description:
          'Every distinct item the customer wants to exchange, as a SEPARATE entry. Use this whenever the request involves exchanging specific items - INCLUDING when the thread has multiple emails about the same order, each exchanging a different item. Read the WHOLE conversation and list every requested exchange. For a single-item request you may leave this empty and use the top-level fields. ONLY list items the customer actually NAMES - NEVER fabricate placeholder entries like "another shirt" or "untitled item" for items you cannot name. When the request covers ALL items, or all EXCEPT some ("all the others in 3XL", "everything but the bison tee"), leave those unnamed items OUT of this list and use exchange_all_except instead.',
        items: {
          type: 'object',
          properties: {
            item_hint: {
              type: 'string',
              description: 'The product this exchange is about (verbatim-ish, e.g. "Patriotic Peaks graphite").',
            },
            current_size: { type: 'string', description: 'Size they currently have for this item.' },
            requested_size: {
              type: 'string',
              description:
                'Size they want for this item. OMIT when no exact size is named ("one size up" = size_direction only) - never output placeholders like "UNKNOWN".',
            },
            size_direction: {
              type: 'string',
              enum: ['up', 'down'],
              description: 'Bigger/smaller when no exact size is named.',
            },
            requested_color: {
              type: 'string',
              description: 'A DIFFERENT color they want for this item (not just describing the current color).',
            },
          },
        },
      },
      exchange_all_except: {
        type: 'object',
        description:
          'Set when the customer exchanges ALL items on the order, or all EXCEPT ones they name as fitting/keeping (e.g. "Walking with Legends fits - all others in 3XL please"). The order line items are resolved later by the app; do NOT try to enumerate items the customer did not name.',
        properties: {
          keep_hints: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Items the customer says FIT or should NOT be exchanged, verbatim-ish (empty array = exchange truly everything).',
          },
          requested_size: {
            type: 'string',
            description:
              'The size all the exchanged items should become. OMIT when no exact size is named ("one size up for all" = size_direction only) - never output placeholders like "UNKNOWN".',
          },
          size_direction: {
            type: 'string',
            enum: ['up', 'down'],
            description: 'Bigger/smaller when no exact size is named.',
          },
          requested_color: {
            type: 'string',
            description: 'A different color for the exchanged items, if requested.',
          },
        },
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
          'True if the customer wants the order shipped somewhere other than the current ' +
          'shipping address but does NOT spell out a complete new street address - so the ' +
          'billing address already on the order is the likely intended destination. This ' +
          'covers both the explicit case ("please use my billing address", "send it to the ' +
          'billing address instead") AND the implicit case where they name a different ' +
          'place or say it is going to the wrong one (e.g. "it is being sent to Arizona but ' +
          'I need it at my new address in Montana", "wrong address, ship to my new house") ' +
          'without giving the full street/city/zip. Set false if the customer DOES provide a ' +
          'complete new address (capture that in new_address instead), or if no redirect is requested.',
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

  // The model sometimes emits a placeholder SENTINEL instead of omitting an
  // optional field it can't fill - Melissa/#24154 got requested_size
  // "<UNKNOWN>" on every item ("one size up for all three" named no size),
  // which the UI printed verbatim. Treat sentinels as absent.
  const cleanStr = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    if (!t) return undefined;
    if (
      /^[<([{]?\s*(unknown|n\/?a|none|null|tbd|not specified|unspecified|same)\s*[>)\]}]?$/i.test(
        t
      )
    ) {
      return undefined;
    }
    return t;
  };

  const entities: TriageEntities = {
    requestedSize: cleanStr(raw.requested_size),
    currentSize: cleanStr(raw.current_size),
    sizeDirection:
      raw.size_direction === 'up' || raw.size_direction === 'down'
        ? raw.size_direction
        : undefined,
    requestedColor: cleanStr(raw.requested_color),
    lineItemHint: cleanStr(raw.line_item_hint),
    exchangeItems: Array.isArray(raw.exchange_items)
      ? (raw.exchange_items as Record<string, unknown>[])
          .map((e) => ({
            itemHint: cleanStr(e.item_hint),
            currentSize: cleanStr(e.current_size),
            requestedSize: cleanStr(e.requested_size),
            sizeDirection:
              e.size_direction === 'up' || e.size_direction === 'down'
                ? (e.size_direction as 'up' | 'down')
                : undefined,
            requestedColor: cleanStr(e.requested_color),
          }))
          .filter(
            (e) =>
              e.itemHint || e.requestedSize || e.requestedColor || e.sizeDirection
          )
      : undefined,
    exchangeAllExcept: (() => {
      const rawAll = raw.exchange_all_except as
        | {
            keep_hints?: unknown[];
            requested_size?: string;
            size_direction?: string;
            requested_color?: string;
          }
        | undefined;
      if (!rawAll) return undefined;
      const size = cleanStr(rawAll.requested_size);
      const dir =
        rawAll.size_direction === 'up' || rawAll.size_direction === 'down'
          ? (rawAll.size_direction as 'up' | 'down')
          : undefined;
      const color = cleanStr(rawAll.requested_color);
      if (!size && !dir && !color) return undefined;
      return {
        keepHints: Array.isArray(rawAll.keep_hints)
          ? rawAll.keep_hints
              .map((h) => cleanStr(h))
              .filter((h): h is string => !!h)
          : [],
        requestedSize: size,
        sizeDirection: dir,
        requestedColor: color,
      };
    })(),
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
    'DISCOUNT',
    'UNSUBSCRIBE',
    'WHOLESALE',
    'SPAM',
    'OTHER',
  ]);
  let intent = validIntents.has(raw.intent as string)
    ? (raw.intent as TriageIntent)
    : ('OTHER' as TriageIntent);

  let confidence =
    typeof raw.confidence === 'number'
      ? Math.max(0, Math.min(1, raw.confidence))
      : 0.5;

  // Deterministic safety net: an obvious opt-out ("STOP", "unsubscribe") is an
  // UNSUBSCRIBE no matter what the model said.
  if (isUnsubscribeText(input.latestMessage)) {
    intent = 'UNSUBSCRIBE' as TriageIntent;
    confidence = Math.max(confidence, 0.9);
  }

  return { intent, confidence, entities, model: TRIAGE_MODEL };
}
