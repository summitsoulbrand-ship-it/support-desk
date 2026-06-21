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
import {
  COMPANY_IDENTITY,
  BRAND_VOICE_GUIDELINES,
  STORE_POLICY_FACTS,
  ISSUE_HANDLING_RULES,
  withOperatorInstructions,
} from './brand-voice';

/**
 * System prompt for customer service responses
 * Implements brand voice and guardrails
 */
const SYSTEM_PROMPT = `You are the customer service voice of Summit Soul. ${COMPANY_IDENTITY} You draft reply emails that are READY TO SEND to customers.

## How to write (most important)
- The GOLD-STANDARD templates further down are the model for every reply. Find the one that matches this situation and mirror it as closely as you can: same warmth, same SHORT length, same structure. Change only the specifics (name, size, item, order) to fit THIS customer using the facts you are given.
- Answer the customer's actual latest message and every question or item in it - and add NOTHING they did not raise. No extra offer, no discount, no sustainability/tree line, no apology for something they did not mention. Skip filler openers ("Thanks for reaching out", "Of course we can help with this") and filler closings - get straight to the answer the way the templates do.
- Use ONLY the facts you are given. Never invent a tracking number, date, amount, order status, item detail, or an occasion/relationship/who the order is for. If a fact you need is not there, say you are checking instead of guessing.
- Do not offer a replacement, refund, or cancellation unless the facts, the templates, or the Store Policy clearly call for it. (Built into policy: a FIRST "my package is lost / never arrived" message gets reassurance and a check, NOT an immediate replacement.)
- Some messages in the thread are OUR automated emails (order/shipping notices, "How'd it go?" review requests). Those are not the customer talking - do not invent a request from them.

${BRAND_VOICE_GUIDELINES}

${STORE_POLICY_FACTS}

${ISSUE_HANDLING_RULES}

## Format and output
- Open with "Hi [First name]," on its own line, then the reply in short paragraphs with a blank line between each, then the signature.
- If a signature is provided in the context, use it EXACTLY as given - do not add any other sign-off or the agent name before it. If none is provided, end with a simple "Best regards," and the agent name.
- Never use em dashes - plain hyphens only. No markdown, no internal notes or commentary. Output ONLY the ready-to-send email.`;

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

// An independent, cheaper model reviews each draft (the verify pass). A
// different model from the writer catches more than self-grading, and Haiku is
// plenty for a grounded checklist check while keeping cost/latency low.
const VERIFIER_MODEL =
  process.env.CLAUDE_VERIFIER_MODEL || 'claude-haiku-4-5-20251001';

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
    return withOperatorInstructions(SYSTEM_PROMPT, this.customPrompt);
  }

  /**
   * The model this service will call (after legacy-id normalization)
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Render the EXACT facts block the model receives for a context - the same
   * text generateSuggestion sends. Powers the "What the AI saw" review panel so
   * the operator can confirm the draft was grounded in the right orders,
   * items, and (clean) message history. Read-only, no API call.
   */
  renderContextForReview(context: SuggestionContext): string {
    return this.buildUserMessage(context);
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

    // Spotlight the customer's LATEST message so the model answers the actual
    // ask, not the surrounding context. The last non-"Support Team" message is
    // the one that triggered this draft. Explicit structure beats hoping the
    // model infers which message to answer - and it forces it to cover EVERY
    // item/question, the common "missed the 2nd thing" failure.
    const lastCustomer = [...context.messages]
      .reverse()
      .find((m) => m.from !== 'Support Team');
    // Skip in refinement mode: the operator is EDITING an existing draft, so
    // "answer the customer's message fresh" competes with their edit instruction.
    if (!context.refinement && lastCustomer && lastCustomer.body.trim()) {
      message += '## THE MESSAGE TO ANSWER (reply to THIS)\n\n';
      message += `${lastCustomer.body.trim()}\n\n`;
      message +=
        'Write a reply that directly addresses THIS message and EVERY distinct ' +
        'question, item, or request in it. If it mentions more than one item, ' +
        'order, size, or question, address each one - do not answer only the first. ' +
        'Use the facts below; if a fact you need is not there, say you are checking ' +
        'rather than inventing it.\n\n';
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
        if (context.shopifyOrder.estimatedDeliveryWindow) {
          message += `- Estimated delivery window (computed - order not shipped yet, share as an ESTIMATE if asked when it will arrive): ${context.shopifyOrder.estimatedDeliveryWindow}\n`;
        }
        if (context.shopifyOrder.billingAddressOnFile) {
          message += `- Billing Address On File (differs from shipping): ${context.shopifyOrder.billingAddressOnFile}\n`;
        }
        if (context.shopifyOrder.addressChangeNote) {
          message += `- ${context.shopifyOrder.addressChangeNote}\n`;
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
      if (t.deliveredAt) message += `- Delivered on: ${t.deliveredAt} (carrier-confirmed) - reference this date when reassuring the customer\n`;
      if (t.estimatedDelivery) message += `- Estimated delivery: ${t.estimatedDelivery}\n`;
      if (t.latestEvent) message += `- Latest update: ${t.latestEvent}\n`;
      if (typeof t.daysSinceLastUpdate === 'number' && !t.isDelivered)
        message += `- Last carrier scan: ${t.daysSinceLastUpdate} day(s) ago\n`;
      if (t.stalled)
        message += `- TRACKING APPEARS STALLED: no new carrier scan in ${t.daysSinceLastUpdate} days. The latest event above is OLD, not current movement. Tell the customer the carrier has not scanned it recently (packages can sit between scans and look stuck) - do NOT say it is currently in transit, moving, or "last scanned in [city]" as if that just happened.\n`;
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

    if (context.changeBeforeProduction && !context.exchangeSizeIssue) {
      message += '\n## We can change this order BEFORE it prints\n\n';
      message +=
        `Order ${context.changeBeforeProduction.orderNumber} has NOT been sent to production yet, so we can change the order itself to the size/item they want - we are NOT sending a separate free replacement. ` +
        'Confirm warmly that we caught it in time and are updating their order to the requested size/item before it goes to print, at no extra cost. ' +
        'Do NOT tell them to keep, gift, or donate the original, and do NOT mention a "replacement" order or sending anything back - there is no duplicate, we are simply changing the one order they placed. ' +
        'Keep it short and reassuring.\n';
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

    if (!context.refinement && context.fewShotExamples && context.fewShotExamples.length > 0) {
      message += '\n## GOLD-STANDARD reply templates (mirror these closely)\n\n';
      message += 'These are real replies from our best period - the slim, on-brand style we want. TREAT THEM AS TEMPLATES: closely mirror their structure, length, and phrasing, and just adapt the specifics (size, item, name) to THIS customer using the facts above. Match how SHORT they are - do NOT add any offer, sentence, sustainability/tree line, discount, or topic the customer did not raise. Never copy a specific name, order number, address, date, or amount out of them - use only THIS thread\'s facts.\n\n';
      for (let i = 0; i < context.fewShotExamples.length; i++) {
        const ex = context.fewShotExamples[i];
        message += `### Example ${i + 1}\n`;
        message += `Customer wrote:\n${ex.customer}\n\n`;
        message += `Our reply:\n${ex.reply}\n\n`;
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
      message += '\n\n## Task (the operator instruction below OVERRIDES the defaults above)\n\n';
      message += 'The operator is EDITING the draft above. Apply their Refinement Instructions EXACTLY and faithfully - their instruction is the priority and takes precedence over the default tone, length, and structure guidance. ';
      message += 'Make ONLY the change they asked for and keep the rest of the draft as-is. Do NOT re-answer the conversation from scratch, do NOT add content they did not ask for, and do NOT undo or water down their requested change. ';
      message += 'Keep facts accurate (never invent). Use proper line breaks between paragraphs. ';
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

  /**
   * Independent QA pass over a generated draft ("review beats generate"): a
   * SEPARATE, cheaper model re-reads the exact facts the writer had and checks
   * the draft actually answers the customer's latest question, references the
   * right order, and invents no facts. Returns short human-readable issues to
   * surface to the agent as draft warnings - it never blocks or rewrites.
   *
   * Uses a different (smaller) model on purpose: an independent reviewer catches
   * more than a model grading its own work, and keeps the cost/latency low.
   */
  async verifyDraft(
    context: SuggestionContext,
    draft: string
  ): Promise<{ ok: boolean; issues: string[] }> {
    // Nothing to check for the no-reply intents (empty body) or blank drafts.
    if (!draft || !draft.trim()) return { ok: true, issues: [] };
    try {
      const facts = this.buildUserMessage(context);
      const system =
        'You are a strict QA reviewer for Summit Soul customer-service email drafts. ' +
        'You are given (A) the FACTS the writer had - the customer\'s own messages plus the order/tracking/production data - and (B) a DRAFT reply. ' +
        'Judge ONLY against those facts. Reply with a single JSON object and nothing else:\n' +
        '{"answers_question": true|false, "correct_order": true|false|null, "unsupported_claims": [string], "missed_points": [string]}\n' +
        '- answers_question: does the draft actually address what the customer asked in their LATEST message?\n' +
        '- correct_order: if the reply is about a specific order, does it reference the order the FACTS point to? null if not order-specific.\n' +
        '- unsupported_claims: any concrete fact the draft asserts (a tracking number, delivery/ship date, order status, refund amount, what is in the order, a size/color) that is NOT supported by the FACTS. These are likely hallucinations.\n' +
        '- missed_points: distinct things the customer asked for that the draft ignored (e.g. a SECOND item to exchange, a second question, a second order).\n' +
        'Be strict but do NOT invent problems: only flag what is genuinely wrong or missing. Empty arrays when all good. Output JSON only.';

      const response = await this.client.messages.create({
        model: VERIFIER_MODEL,
        max_tokens: 700,
        system,
        messages: [
          {
            role: 'user',
            content: `## FACTS THE WRITER HAD\n\n${facts}\n\n## DRAFT REPLY\n\n${draft}`,
          },
        ],
      });

      const textContent = response.content.find((c) => c.type === 'text');
      const raw = textContent && textContent.type === 'text' ? textContent.text : '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { ok: true, issues: [] };
      const v = JSON.parse(jsonMatch[0]) as {
        answers_question?: boolean;
        correct_order?: boolean | null;
        unsupported_claims?: string[];
        missed_points?: string[];
      };

      const issues: string[] = [];
      if (v.answers_question === false) {
        issues.push("Verifier: the draft may not answer the customer's actual question.");
      }
      if (v.correct_order === false) {
        issues.push('Verifier: the draft may reference the wrong order.');
      }
      for (const c of v.unsupported_claims || []) {
        if (c && c.trim()) issues.push(`Verifier: unsupported claim - ${c.trim()}`);
      }
      for (const m of v.missed_points || []) {
        if (m && m.trim()) issues.push(`Verifier: missed point - ${m.trim()}`);
      }
      return { ok: issues.length === 0, issues };
    } catch (err) {
      // Verification is best-effort - never fail the draft over it.
      console.error('Draft verification failed:', err);
      return { ok: true, issues: [] };
    }
  }

  /**
   * EVAL ONLY (offline harness): score a freshly-generated draft against the
   * reply a human actually sent (the reference / ground truth) for the same
   * customer message. An LLM-as-judge scores 1-5 on whether it addressed the
   * question, factual consistency with the reference, completeness, and tone,
   * and lists failure modes. Used by src/scripts/eval to measure accuracy and
   * catch regressions when prompts change. Not called from the request path.
   */
  async judgeDraft(input: {
    customerMessage: string;
    draft: string;
    reference: string;
  }): Promise<{
    addressesQuestion: number;
    factualConsistency: number;
    completeness: number;
    tone: number;
    pass: boolean;
    failureModes: string[];
    note: string;
  }> {
    const fallback = {
      addressesQuestion: 0,
      factualConsistency: 0,
      completeness: 0,
      tone: 0,
      pass: false,
      failureModes: ['judge_error'],
      note: '',
    };
    try {
      const system =
        'You are an expert QA grader for Summit Soul customer-service email drafts. ' +
        'You are given the CUSTOMER MESSAGE, a DRAFT reply (AI-written), and the REFERENCE reply a human actually sent (ground truth). ' +
        'Grade how good the DRAFT is, using the REFERENCE as the standard of a correct, complete answer. ' +
        'Score each 1-5 (5 best) and reply with a single JSON object only:\n' +
        '{"addresses_question": 1-5, "factual_consistency": 1-5, "completeness": 1-5, "tone": 1-5, "failure_modes": [string], "note": "one short sentence"}\n' +
        '- addresses_question: does the draft answer what the customer actually asked?\n' +
        '- factual_consistency: are the draft\'s facts consistent with the reference? (ignore differences that are clearly just newer order status, not contradictions.)\n' +
        '- completeness: did it cover everything the customer asked (all items/questions/orders), like the reference did?\n' +
        '- tone: warm, on-brand, concise like the reference?\n' +
        '- failure_modes: zero or more of: missed_question, wrong_order, hallucinated_fact, missed_item, ignored_prior_email, wrong_policy, tone_off, other. Empty if none.\n' +
        'Output JSON only.';

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 700,
        system,
        messages: [
          {
            role: 'user',
            content:
              `## CUSTOMER MESSAGE\n\n${input.customerMessage}\n\n` +
              `## DRAFT (grade this)\n\n${input.draft}\n\n` +
              `## REFERENCE (human-sent, ground truth)\n\n${input.reference}`,
          },
        ],
      });
      const textContent = response.content.find((c) => c.type === 'text');
      const raw = textContent && textContent.type === 'text' ? textContent.text : '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return fallback;
      const j = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const num = (v: unknown) => (typeof v === 'number' ? v : 0);
      const addressesQuestion = num(j.addresses_question);
      const factualConsistency = num(j.factual_consistency);
      const completeness = num(j.completeness);
      const tone = num(j.tone);
      const failureModes = Array.isArray(j.failure_modes)
        ? (j.failure_modes as unknown[]).map(String)
        : [];
      // "Pass" = all the accuracy dimensions are solid (>=4) and no failure mode.
      const pass =
        addressesQuestion >= 4 &&
        factualConsistency >= 4 &&
        completeness >= 4 &&
        failureModes.length === 0;
      return {
        addressesQuestion,
        factualConsistency,
        completeness,
        tone,
        pass,
        failureModes,
        note: typeof j.note === 'string' ? j.note : '',
      };
    } catch (err) {
      console.error('Draft judge failed:', err);
      return fallback;
    }
  }
}
