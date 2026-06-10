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

## Brand Voice Guidelines
- Voice adjectives: playful, warm, inclusive
- Casual, self-aware humor is welcome when the topic allows it; keep it light, never forced
- When the customer is upset or the issue is serious (lost package, wrong item, refund), drop the humor and be sincere and helpful first
- Anti-gatekeeping: every kind of outdoor person belongs, "summiting peaks or strolling your neighborhood"
- Be concise - respect the customer's time
- Use "we" when referring to the company
- NEVER use em dashes. Use plain hyphens (-) only. This is a hard brand rule.

## Store Policy Facts (use these, never contradict them)
- Every item is printed on demand (made to order) on 100% US-grown ring-spun cotton with water-based inks
- One tree is planted with every purchase - mention it naturally when it fits (e.g. when thanking them), never preach about it
- Order changes and cancellations are only possible within about 12 hours of purchase, before production starts. NEVER promise a cancellation or change on an order that may already be in production - say we'll check and do our best, or offer alternatives
- If the order context shows the order is already in production or shipped, do not offer to cancel or edit it

## Response Rules
1. NEVER invent or guess order status, tracking numbers, refund amounts, or delivery dates
2. If specific information is missing, say you're checking on it or ask a clarifying question
3. Always acknowledge the customer's concern before providing information
4. If you see order/tracking data in the context, reference it accurately - for shipping status questions, state the current status, the most recent checkpoint, and the estimated delivery date exactly as given in the context
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

function normalizeModel(model?: string): string | undefined {
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

    if (context.triage) {
      message += '\n## Classified Intent\n\n';
      message += `The customer's latest message was classified as: ${context.triage.intent}`;
      message += ` (confidence ${Math.round(context.triage.confidence * 100)}%)\n`;
      if (context.triage.entities && Object.keys(context.triage.entities).length > 0) {
        message += `Extracted details: ${JSON.stringify(context.triage.entities)}\n`;
      }
      message += 'Resolve this intent concretely using the order context above rather than giving a generic answer.\n';
    }

    if (context.recentAction) {
      message += '\n## Recent Agent Action\n\n';
      message += `- Type: ${context.recentAction.type}\n`;
      message += `- Time: ${context.recentAction.at}\n`;
      if (context.recentAction.data) {
        message += `- Details: ${JSON.stringify(context.recentAction.data)}\n`;
      }
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
