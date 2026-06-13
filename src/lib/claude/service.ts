/**
 * Claude suggestion service
 * Generates customer service reply drafts using Claude API
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  ClaudeConfig,
  SuggestionContext,
  SuggestionResult,
} from './types';

/**
 * System prompt for customer service responses
 * Implements brand voice and guardrails
 */
const SYSTEM_PROMPT = `You are the customer service voice of Summit Soul (summitsoul.shop), a small made-to-order apparel brand selling funny nature graphic t-shirts, long sleeves, hoodies, and sweatshirts. The brand is run by Pati, an owner-operator in Huntington Beach, CA, with her trail dog Aiko. Customers are self-identified "Nature Nerds" - rock hounds, birders, tree people, Bigfoot fans, and casual hikers. Your job is to draft reply emails that are READY TO SEND to customers.

## Brand Voice Guidelines (customer service tone)
- Warm, friendly, human, AND professional. Sound like a real, considerate person who works at the company - not a corporate script, and not overly casual.
- The brand's marketing voice is playful, but customer service replies lean professional: clear, polished, and genuine. Keep the warmth, lose the slang.
- Do NOT use slangy or cutesy filler. Banned examples: "give a shout", "drop us a line", "hit us up", "no worries at all!", "fellow nature nerd", "happy trails", excessive exclamation points, or insider jargon the customer may not understand. When in doubt, say it plainly.
- You may warmly acknowledge their support of a small business, but do not overdo it or label the customer (e.g. don't call them a "nature nerd" unless they used that wording themselves).
- When the customer is upset or the issue is serious (lost package, wrong item, refund), be sincere, clear, and helpful - no jokes.
- Be concise and clear - respect the customer's time.
- Close simply and professionally, e.g. "If there is anything else we can help with, just reply to this email and we will be glad to help." Avoid vague or quirky sign-offs.
- Use "we" when referring to the company.
- NEVER use em dashes. Use plain hyphens (-) only. This is a hard brand rule.

## Store Policy Facts (use these, never contradict them)
- Every item is printed on demand (made to order) on 100% US-grown ring-spun cotton with water-based inks
- One tree is planted with every purchase - mention it naturally when it fits (e.g. when thanking them), never preach about it
- Order changes and cancellations are only possible within about 12 hours of purchase, BEFORE production starts
- HARD RULE - once an order is IN PRODUCTION or SHIPPED, NO changes are possible: not the address, not the size, not a cancellation. Never promise, imply, or offer "we'll try" on a change at these stages. Check the Printify production status and Carrier Tracking sections to know the stage; if they are missing, do not assume a change is still possible - say you're checking whether it can still be caught
- When a change request arrives too late, do NOT just refuse: acknowledge the frustration, explain in one friendly sentence that the made-to-order printing has already started (or the package is already with the carrier), and offer a concrete alternative. Good alternatives: a discount on a corrected new order, a free replacement when the error is ours, or for address issues a carrier pointer (e.g. USPS Package Intercept / asking the local post office to hold it) plus the promise to send a replacement if the package comes back undeliverable. Pick what fits; never leave the customer with a bare "no"

## Response Rules
1. NEVER invent or guess order status, tracking numbers, refund amounts, or delivery dates
2. If specific information is missing, say you're checking on it or ask a clarifying question
3. Always acknowledge the customer's concern before providing information
4. If you see order/tracking data in the context, reference it accurately - for shipping status questions, state the current status, the most recent checkpoint, and the estimated delivery date exactly as given in the context. ALWAYS include the tracking link so the customer can follow live updates (the carrier page also shows their current delivery estimate). When the context has no estimated delivery at all, give the typical made-to-order timeline from the Shipping Policy in Store Knowledge (production time plus transit), phrased as "typically" - never invent a specific date
4a. SHIPPED vs NOT SHIPPED: a tracking number, a "fulfilled" status, or a "label created / info received" tracking state does NOT mean the order has shipped. Print-on-demand labels are often created while the item is still being made. Treat the "Carrier Tracking" section as the source of truth: only say the order has shipped or is "on its way" when "Has it actually shipped" is YES. If it is NO, tell the customer their order is still being made / a label has been created but the carrier has not picked it up yet, and share the estimated delivery if available. Never tell a customer their order shipped when it has not.
5. For delays or issues, apologize sincerely without being excessive
6. End with a helpful closing that invites further questions
7. If a "Classified Intent" section is provided, resolve that intent concretely using the order context instead of giving a generic answer

## Email Format (CRITICAL - MUST FOLLOW EXACTLY)
Your response MUST be a ready-to-send email with proper line breaks:

Hi [First Name],

[Opening paragraph - thank them or acknowledge their message]

[Body paragraph(s) - address their question/concern, 2-3 sentences each]

[Closing line - invite further questions]

[Signature - see below]

IMPORTANT FORMATTING RULES:
- Use BLANK LINES between paragraphs
- Keep paragraphs short (2-3 sentences max)
- The greeting MUST be on its own line with a blank line after

## Signature Rules (CRITICAL)
- If an agent signature is provided in the context, use it EXACTLY as provided - do NOT add your own sign-off or the agent name before it
- The signature already contains everything needed (sign-off, name, contact info etc.)
- Do NOT duplicate the sign-off or agent name - just use the provided signature as-is
- If NO signature is provided, end with a simple sign-off and the agent name (e.g., "Best regards,\nAgent Name")

## What NOT to do
- Don't make promises about specific dates unless you have tracking data showing it
- Don't offer refunds/replacements without explicit authorization
- Don't share internal production details like print provider names
- Don't use corporate jargon or overly formal language
- Don't be apologetic to the point of seeming insincere
- Don't use generic greetings like "Dear Customer" - use their name
- Don't include ANY internal notes, commentary, or markdown formatting in the reply

You will receive the conversation history, agent info, and any available order context. Draft a reply that addresses the customer's most recent message.

OUTPUT FORMAT:
Return ONLY the customer-facing email reply. Do NOT include any internal notes, agent notes, or commentary. The entire response should be ready to copy/paste and send to the customer.`;

/**
 * Map retired/legacy model ids (possibly still stored in integration settings)
 * to current equivalents so a stale DB value can't 404 against the API.
 */
const RETIRED_MODEL_MAP: Record<string, string> = {
  'claude-sonnet-4-20250514': 'claude-opus-4-8',
  'claude-opus-4-20250514': 'claude-opus-4-8',
  'claude-3-5-haiku-20241022': 'claude-haiku-4-5-20251001',
  'claude-3-5-sonnet-20241022': 'claude-opus-4-8',
};

export function normalizeModel(model?: string): string | undefined {
  if (!model) return undefined;
  return RETIRED_MODEL_MAP[model] || model;
}

export class ClaudeService {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private projectId?: string;
  private customPrompt?: string;

  constructor(config: ClaudeConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
    });
    this.model = normalizeModel(config.model) || 'claude-opus-4-8';
    this.maxTokens = config.maxTokens || 2048;
    this.projectId = config.projectId;
    this.customPrompt = config.customPrompt;
  }

  /**
   * Get the system prompt. The built-in brand prompt is always the base;
   * a custom prompt from settings is appended as operator instructions so
   * stale stored prompts can no longer silently replace the brand voice.
   */
  private getSystemPrompt(): string {
    if (this.customPrompt && this.customPrompt.trim().length > 0) {
      return `${SYSTEM_PROMPT}\n\n## Additional Operator Instructions\n${this.customPrompt.trim()}`;
    }
    return SYSTEM_PROMPT;
  }

  /**
   * The model this service will call (after legacy-id normalization)
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Test API connection
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hello' }],
      });
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error };
    }
  }

  /**
   * Build the user message with context
   */
  private buildUserMessage(context: SuggestionContext): string {
    let message = '## Conversation History\n\n';

    for (const msg of context.messages) {
      message += `**From:** ${msg.from}\n`;
      message += `**Date:** ${msg.date}\n`;
      message += `**Subject:** ${msg.subject}\n\n`;
      message += msg.body + '\n\n---\n\n';
    }

    // Add order context
    if (context.customer || context.shopifyOrder || context.printifyOrder) {
      message += '\n## Order Context\n\n';

      if (context.customer) {
        message += '### Customer Info\n';
        message += `- Name: ${context.customer.name}\n`;
        message += `- Email: ${context.customer.email}\n`;
        message += `- Total Spent: ${context.customer.totalSpent}\n`;
        message += `- Number of Orders: ${context.customer.numberOfOrders}\n`;
        if (context.customer.tags.length > 0) {
          message += `- Tags: ${context.customer.tags.join(', ')}\n`;
        }
        message += '\n';
      }

      if (context.shopifyOrder) {
        message += '### Most Recent Order\n';
        message += `- Order Number: ${context.shopifyOrder.orderNumber}\n`;
        message += `- Status: ${context.shopifyOrder.status}\n`;
        message += `- Fulfillment: ${context.shopifyOrder.fulfillmentStatus || 'Not yet fulfilled'}\n`;
        message += `- Created: ${context.shopifyOrder.createdAt}\n`;
        message += `- Total: ${context.shopifyOrder.totalPrice} ${context.shopifyOrder.currency}\n`;

        if (context.shopifyOrder.lineItems.length > 0) {
          message += '- Items:\n';
          for (const item of context.shopifyOrder.lineItems) {
            message += `  - ${item.title} (x${item.quantity})\n`;
          }
        }

        if (context.shopifyOrder.trackingNumber) {
          message += `- Tracking: ${context.shopifyOrder.trackingNumber}\n`;
          if (context.shopifyOrder.trackingUrl) {
            message += `- Tracking URL: ${context.shopifyOrder.trackingUrl}\n`;
          }
        }

        if (context.shopifyOrder.shippingAddress) {
          message += `- Shipping To: ${context.shopifyOrder.shippingAddress}\n`;
        }
        message += '\n';
      }

      if (context.printifyOrder) {
        message += '### Production Status (Printify)\n';
        message += `- Order Status: ${context.printifyOrder.status}\n`;
        message += `- Production: ${context.printifyOrder.productionStatus}\n`;

        if (context.printifyOrder.lineItems.length > 0) {
          message += '- Item Production Status:\n';
          for (const item of context.printifyOrder.lineItems) {
            message += `  - ${item.title || 'Item'}: ${item.status}\n`;
          }
        }

        if (context.printifyOrder.shipments.length > 0) {
          message += '- Shipments:\n';
          for (const shipment of context.printifyOrder.shipments) {
            message += `  - ${shipment.carrier}: ${shipment.trackingNumber}\n`;
            if (shipment.trackingUrl) {
              message += `    URL: ${shipment.trackingUrl}\n`;
            }
          }
        }
        message += '\n';
      }
    }

    if (context.trackingInfo) {
      const t = context.trackingInfo;
      message += '\n## Carrier Tracking (source of truth for shipped status)\n';
      message += `- Status: ${t.status}\n`;
      message += `- Has it actually shipped: ${t.hasShipped ? 'YES - the carrier has the package' : 'NO - not shipped yet (a label may exist, but the carrier has not picked it up; the item may still be in production)'}\n`;
      if (t.carrier) message += `- Carrier: ${t.carrier}\n`;
      if (t.trackingNumber) message += `- Tracking number: ${t.trackingNumber}\n`;
      if (t.estimatedDelivery) message += `- Estimated delivery: ${t.estimatedDelivery}\n`;
      if (t.latestEvent) message += `- Latest update: ${t.latestEvent}\n`;
      if (t.hasDelay) message += `- Note: this is taking longer than usual (still in production or awaiting carrier pickup)\n`;
      if (t.proofOfDeliveryUrl) {
        message += `- Proof of delivery (carrier photo/document): ${t.proofOfDeliveryUrl}\n`;
        message += `  When the customer says the package is lost or not received but the carrier shows DELIVERED, include this proof link in the reply and suggest checking with household members/neighbors and the exact drop spot shown.\n`;
      }
      message += '\n';
    }

    if (context.orderCandidates && context.orderCandidates.length > 1) {
      message += '\n## Customer Has Multiple Orders\n\n';
      for (const o of context.orderCandidates) {
        message += `- Order ${o.orderNumber} (placed ${o.createdAt}, ${o.fulfillmentStatus || 'unfulfilled'}): ${o.items.join('; ')}\n`;
      }
      message += '\n';
      if (context.orderMatch?.ambiguous) {
        message +=
          'It is NOT clear which order this request is about (' +
          `${context.orderMatch.reason}). Do NOT assume. In your reply, politely ask the customer which order they mean, naming each option by its item and order number so they can pick easily.\n`;
      } else if (context.orderMatch?.matchedOrderNumber) {
        message +=
          `This request is most likely about order ${context.orderMatch.matchedOrderNumber} (${context.orderMatch.reason}). ` +
          'Reference that order by number in your reply. If anything seems off, confirm the order with the customer rather than guessing.\n';
      }
    }

    if (context.exchangeSizeIssue) {
      const { claimedSize, orderNumber, orderedSizes } =
        context.exchangeSizeIssue;
      message += '\n## Size Mismatch - DO NOT confirm a replacement\n\n';
      message +=
        `The customer says they have a size ${claimedSize}, but their order ${orderNumber} ` +
        `does not contain a ${claimedSize}. That order has: ${orderedSizes.length ? orderedSizes.join(', ') : 'no sized apparel'}. ` +
        'This is a contradiction. Do NOT confirm, promise, or create an exchange. ' +
        'Politely tell the customer what their order actually shows, and ask them to confirm which item and size they have so the right exchange can be set up. ' +
        'Assume an honest mix-up (maybe a different order, a gift, or a misremembered size) and stay warm.\n';
    }

    if (context.extraInstructions) {
      message += `\n## Situation\n\n${context.extraInstructions}\n`;
    }

    if (context.triage) {
      message += '\n## Classified Intent\n\n';
      message += `The customer's latest message was classified as: ${context.triage.intent}`;
      message += ` (confidence ${Math.round(context.triage.confidence * 100)}%)\n`;
      if (context.triage.entities && Object.keys(context.triage.entities).length > 0) {
        message += `Extracted details: ${JSON.stringify(context.triage.entities)}\n`;
      }
      message += 'Resolve this intent concretely using the order context above rather than giving a generic answer.\n';
    }

    if (
      context.replacementsAlreadyCreated &&
      context.replacementsAlreadyCreated.length > 0
    ) {
      message += '\n## Replacement orders that ALREADY EXIST for this customer\n\n';
      for (const r of context.replacementsAlreadyCreated) {
        message += `- ${r.replacementOrder}${r.forOrder ? ` (replacing ${r.forOrder})` : ''} - created ${r.createdAt}, status: ${r.fulfillmentStatus || 'unfulfilled'} - ${r.items.join(', ')}\n`;
      }
      message +=
        'HARD RULE: if the customer asks about an exchange or replacement that one of these orders already covers, do NOT promise to create one - tell them it was already created (name the order number and its current status). If they say they did not receive a confirmation email, acknowledge that and restate the facts of the existing replacement.\n';
    }

    if (context.recentAction) {
      message += '\n## Recent Agent Action\n\n';
      message += `- Type: ${context.recentAction.type}\n`;
      message += `- Time: ${context.recentAction.at}\n`;
      if (context.recentAction.data) {
        message += `- Details: ${JSON.stringify(context.recentAction.data)}\n`;
      }
      message +=
        'If this action resolves what the customer asked for, write the reply as a ' +
        'confirmation of what HAS BEEN done (state the concrete result, e.g. the new ' +
        'address or the cancelled order number) - never as a promise to do it.\n';
      message += '\n';
    }

    // Add agent info for signature
    if (context.agent) {
      message += '\n## Agent Info\n\n';
      message += `- Agent Name: ${context.agent.name}\n`;
      if (context.agent.signature) {
        message += `- Email Signature:\n${context.agent.signature}\n`;
      }
      message += '\n';
    }

    // Add feedback examples for learning
    if (context.feedbackExamples && context.feedbackExamples.length > 0) {
      message += '\n## Previous Response Improvements\n\n';
      message += 'Here are examples of how previous drafts were improved. Learn from these to write better responses:\n\n';
      for (let i = 0; i < context.feedbackExamples.length; i++) {
        const example = context.feedbackExamples[i];
        message += `### Example ${i + 1}\n`;
        message += `**Original Draft:**\n${example.original}\n\n`;
        message += `**Improved Version:**\n${example.edited}\n\n`;
      }
    }

    // Store knowledge - brand voice, avatar, and the store's own pages/policies.
    // Authoritative for policy/FAQ/sizing questions; do not contradict it.
    if (context.knowledge && context.knowledge.length > 0) {
      message += '\n## Store Knowledge (authoritative reference)\n\n';
      message += 'Use this to answer policy, shipping, returns, sizing, and FAQ questions accurately. Do not contradict it or invent details beyond it.\n';
      message += 'When pointing the customer to a product or collection, ONLY use links that appear below - never guess a URL. If they ask for something not listed, link to the store search like https://<store-domain>/search?q=their+terms.\n\n';
      for (const block of context.knowledge) {
        message += `### ${block.title}\n${block.content}\n\n`;
      }
    }

    // Handle refinement mode
    if (context.refinement) {
      message += '\n## Current Draft (needs refinement)\n\n';
      message += context.refinement.currentDraft;
      message += '\n\n## Refinement Instructions\n\n';
      message += context.refinement.instructions;
      message += '\n\n## Task\n\n';
      message += 'Revise the draft above according to the refinement instructions. ';
      message += 'Keep the overall structure and intent, but apply the requested changes. ';
      message += 'Use proper line breaks between paragraphs. ';
      if (context.agent) {
        if (context.agent.signature) {
          message += `End the email with ONLY this signature (do NOT add any sign-off or name before it - use the signature exactly as-is):\n\n${context.agent.signature}`;
        } else {
          message += `End with a sign-off like "Best regards," followed by the agent name "${context.agent.name}".`;
        }
      }
      message += '\n\nReturn ONLY the revised customer-facing email - no internal notes or commentary.';
    } else {
      message += '\n## Task\n\n';
      message += 'Draft a ready-to-send email reply to the customer\'s most recent message. ';
      message += 'Consider the entire conversation history above and ensure the reply is consistent with all prior messages. ';
      message += 'Use proper line breaks between paragraphs. ';
      if (context.agent) {
        if (context.agent.signature) {
          message += `End the email with ONLY this signature (do NOT add any sign-off or name before it - use the signature exactly as-is):\n\n${context.agent.signature}`;
        } else {
          message += `End with a sign-off like "Best regards," followed by the agent name "${context.agent.name}".`;
        }
      }
      message += '\n\nReturn ONLY the customer-facing email - no internal notes or commentary.';
    }

    return message;
  }

  /**
   * Parse the response to extract draft and internal notes
   */
  private parseResponse(response: string): SuggestionResult {
    const warnings: string[] = [];

    // Check for potential hallucinations
    const suspiciousPatterns = [
      /will arrive (on|by) \w+ \d+/i,
      /refund of \$[\d.]+/i,
      /your refund has been/i,
      /tracking number: [A-Z0-9]+(?!.*context)/i,
    ];

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(response)) {
        warnings.push(
          'Response may contain specific claims - please verify before sending'
        );
        break;
      }
    }

    // Remove any internal notes that Claude might have added despite instructions
    // Split on common separators for internal notes
    let draft = response;
    const internalNotes: string[] = [];

    // Check for --- separator followed by internal notes
    const separatorMatch = draft.match(/\n---+\s*\n/);
    if (separatorMatch) {
      const separatorIndex = draft.indexOf(separatorMatch[0]);
      const afterSeparator = draft.slice(separatorIndex + separatorMatch[0].length);

      // Check if what follows looks like internal notes
      if (/^\s*\**\s*(internal|agent|note)/i.test(afterSeparator)) {
        draft = draft.slice(0, separatorIndex).trim();

        // Extract notes
        const noteLines = afterSeparator.split('\n');
        for (const line of noteLines) {
          const cleaned = line.replace(/^[-*•]\s*/, '').replace(/^\*+|\*+$/g, '').trim();
          if (cleaned && !/^(internal|agent)\s*notes?:?$/i.test(cleaned)) {
            internalNotes.push(cleaned);
          }
        }
      }
    }

    // Also check for "Internal Notes:" without separator
    const notesMarker = /\n\n\**\s*(internal notes?|agent notes?|notes for agent)\s*:?\**\s*\n/i;
    const notesMatch = draft.match(notesMarker);
    if (notesMatch) {
      const notesIndex = draft.indexOf(notesMatch[0]);
      const afterNotes = draft.slice(notesIndex + notesMatch[0].length);
      draft = draft.slice(0, notesIndex).trim();

      const noteLines = afterNotes.split('\n');
      for (const line of noteLines) {
        const cleaned = line.replace(/^[-*•]\s*/, '').replace(/^\*+|\*+$/g, '').trim();
        if (cleaned) {
          internalNotes.push(cleaned);
        }
      }
    }

    // Clean up any remaining markdown formatting artifacts
    draft = draft.replace(/^\*+|\*+$/gm, '').trim();

    // Brand rule: never em dashes (or en dashes) - plain hyphens only
    draft = draft.replace(/\s*[—–]\s*/g, ' - ');

    // Calculate confidence based on context availability
    let confidence = 0.8;
    if (warnings.length > 0) {
      confidence = 0.6;
    }

    return {
      draft,
      internalNotes: internalNotes.length > 0 ? internalNotes : undefined,
      confidence,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Generate a suggested reply
   */
  async generateSuggestion(
    context: SuggestionContext
  ): Promise<SuggestionResult> {
    try {
      const userMessage = this.buildUserMessage(context);

      // Build request options
      const requestOptions = {
        model: this.model,
        max_tokens: this.maxTokens,
        system: this.getSystemPrompt(),
        stream: false as const,
        messages: [
          {
            role: 'user' as const,
            content: userMessage,
          },
        ],
      };

      // Add project header if configured
      const headers: Record<string, string> = {};
      if (this.projectId) {
        headers['anthropic-project'] = this.projectId;
      }

      const response = await this.client.messages.create(requestOptions, {
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      });

      const textContent = response.content.find((c) => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        throw new Error('No text content in response');
      }

      return this.parseResponse(textContent.text);
    } catch (err) {
      console.error('Claude API error:', err);
      throw err;
    }
  }
}
