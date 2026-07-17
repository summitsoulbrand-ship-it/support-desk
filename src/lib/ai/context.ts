/**
 * Shared suggestion-context builder
 * One code path for both the manual /api/threads/[id]/suggest route and the
 * background pre-draft pipeline. With forceFresh, Shopify order data,
 * Printify production status, and carrier tracking are re-fetched live and
 * the caches updated, so drafts never quote stale information.
 */

import prisma from '@/lib/db';
import {
  SuggestionContext,
  MessageContext,
  buildShopifyContext,
  buildPrintifyContext,
  buildTrackingContext,
  formatAddressLine,
  billingIfDiffers,
  refundedIfAny,
} from '@/lib/claude/types';
import { ShopifyCustomer, ShopifyOrder } from '@/lib/shopify/types';
import { createShopifyClient } from '@/lib/shopify';
import { resolveThreadOrders } from '@/lib/ai/order-resolve';
import { createPrintifyClient, PrintifyClient, type PrintifyOrder } from '@/lib/printify';
import { createTrackingMoreClient, type TrackingResult } from '@/lib/trackingmore';
import { getKnowledgeBlocks } from '@/lib/knowledge';
import { fetchDhlLiveTracking } from '@/lib/tracking/dhl';
import { matchOrderForRequest, sizesEquivalent } from '@/lib/ai/order-match';
import { needsLiveTracking } from '@/lib/ai/tracking-relevance';
import { estimateArrivalWindow } from '@/lib/ai/delivery-window';
import { latestReplyText } from '@/lib/email/latest-reply';
import { goldenTemplatesForIntent } from '@/lib/ai/golden-templates';

export interface BuildContextOptions {
  /** Re-fetch Shopify/Printify/tracking live and update caches */
  forceFresh?: boolean;
  /** Agent identity for the signature block */
  agent?: { name: string; signature?: string };
  /** Include few-shot feedback examples (default true) */
  includeFeedbackExamples?: boolean;
}

export interface BuiltThreadContext {
  context: SuggestionContext;
  warnings: string[];
  /** id of the newest INBOUND message, for draft staleness tracking */
  latestInboundMessageId: string | null;
  contextRefreshedAt: Date | null;
}

interface CustomerOrders {
  customer: ShopifyCustomer | null;
  orders: ShopifyOrder[];
  /** True when orders were found by NAME, not email - unverified, flag it */
  matchedByNameOnly?: boolean;
  /** Caller-facing caveat when the match is not email-verified (name / receipt
   *  / order number). Surfaced as a warning so changes get a human check. */
  unverifiedReason?: string;
  /** How the resolver found the orders - drives how strong the caveat is. */
  method?: 'email' | 'email_typo' | 'name' | 'order_name';
}

async function getCachedCustomerOrders(email: string): Promise<CustomerOrders | null> {
  const cached = await prisma.customerLink.findUnique({ where: { email } });
  if (!cached?.shopifyData) return null;

  const data = cached.shopifyData as {
    customer?: ShopifyCustomer;
    orders?: ShopifyOrder[];
  };
  if (!data.orders || data.orders.length === 0) return null;

  return { customer: data.customer || null, orders: data.orders };
}


/**
 * Approved-size-exchange phrasing. The approve button either EDITS the order
 * in place (pre-production) or creates a free replacement - the confirmation
 * draft has to match, or it promises a "replacement" that never gets created.
 * Wording tuned by Pati; ported verbatim from the retired pre-draft pipeline.
 */
function applyExchangeInstructions(
  context: SuggestionContext,
  thread: {
    triage: { intent: string; entities: unknown } | null;
    lastActionType: string | null;
    lastActionAt: Date | null;
  },
  latestInboundSentAt: Date | null
): void {
  const replacementDone =
    thread.lastActionType === 'replacement_created' &&
    !!thread.lastActionAt &&
    !!latestInboundSentAt &&
    thread.lastActionAt > latestInboundSentAt;
  const isPendingExchange =
    thread.triage?.intent === 'SIZE_EXCHANGE' && !replacementDone;
  if (!isPendingExchange) return;

  // The approved-confirmation wording below assumes the customer actually
  // ASKED for a size swap. A fit complaint that asks to return/refund, or
  // names no outcome at all, must NOT get it - the draft has to ask whether
  // they want a refund or a free replacement first (Pati's rule), not open
  // with "I've got you covered, the replacement is being made". Gate on the
  // triage entities: a refund wish skips it, and some requested size or
  // direction must be present (exchangeSizeIssue implies a claimed size).
  const gateEntities =
    (thread.triage?.entities as {
      wantsRefund?: boolean;
      alreadyReordered?: boolean;
      requestedSize?: string;
      sizeDirection?: string;
      exchangeItems?: { requestedSize?: string; sizeDirection?: string }[];
      exchangeAllExcept?: { requestedSize?: string; sizeDirection?: string };
    } | null) || {};
  const askedForASize =
    !!context.exchangeSizeIssue ||
    !!gateEntities.requestedSize ||
    !!gateEntities.sizeDirection ||
    !!gateEntities.exchangeAllExcept?.requestedSize ||
    !!gateEntities.exchangeAllExcept?.sizeDirection ||
    (gateEntities.exchangeItems || []).some(
      (e) => e.requestedSize || e.sizeDirection
    );
  if (gateEntities.wantsRefund || !askedForASize) return;

  // The claimed size isn't on any order - never auto-confirm; ask instead.
  if (context.exchangeSizeIssue) {
    const { claimedSize, orderNumber, orderedSizes } = context.exchangeSizeIssue;
    context.extraInstructions =
      `IMPORTANT: the customer says they have a size ${claimedSize}, but ${orderNumber} does not contain a ${claimedSize} ` +
      `(it has ${orderedSizes.length ? orderedSizes.join(' and ') : 'no sized apparel'}). ` +
      'Do NOT confirm or create a replacement. Gently point out what their order actually shows, and ask them to confirm which item and size they have so you set up the right exchange. ' +
      'Stay warm and helpful - assume an honest mix-up, not a problem.';
    return;
  }

  const exEntities =
    (thread.triage?.entities as {
      requestedColor?: string;
      exchangeItems?: { itemHint?: string; requestedSize?: string; sizeDirection?: 'up' | 'down'; requestedColor?: string }[];
      newAddress?: {
        address1?: string;
        address2?: string;
        city?: string;
        region?: string;
        zip?: string;
        country?: string;
      };
      exchangeAllExcept?: {
        keepHints: string[];
        requestedSize?: string;
        sizeDirection?: 'up' | 'down';
        requestedColor?: string;
      };
    } | null) || {};
  // "All the others in 3XL - X fits fine": tell the draft explicitly which
  // items are kept vs exchanged, so it neither invents item names nor implies
  // the kept shirt is being replaced (Paul/#23211, 2026-07-07).
  const allExcept = exEntities.exchangeAllExcept;
  const allExceptNote =
    allExcept && (allExcept.requestedSize || allExcept.sizeDirection)
      ? `The customer keeps ${
          allExcept.keepHints.length > 0
            ? allExcept.keepHints.join(' and ') + ' (it fits - do NOT replace it, and acknowledge that)'
            : 'nothing'
        } and exchanges EVERY OTHER item on the order to ${
          allExcept.requestedSize
            ? `size ${allExcept.requestedSize}`
            : `one size ${allExcept.sizeDirection}`
        }. Since they all go to the same size, say "the other shirts" or count them (e.g. "the four other shirts") - do NOT invent or guess product names the customer did not use. `
      : '';
  const multi = exEntities.exchangeItems && exEntities.exchangeItems.length > 1;
  const multiNote = multi
    ? `The customer is exchanging more than one item: ${exEntities
        .exchangeItems!.map((e) => {
          const t = [
            e.requestedSize ? `size ${e.requestedSize}` : e.sizeDirection ? `one size ${e.sizeDirection}` : '',
            e.requestedColor || '',
          ]
            .filter(Boolean)
            .join(', ');
          return `${e.itemHint || 'item'} -> ${t || 'new size'}`;
        })
        .join('; ')}. If they are ALL going to the same new size, just say "shirts" in that size - do NOT list each product; only name each item with its size if the sizes differ. `
    : '';
  // Pre-production (not yet sent to print): the approve button EDITS the
  // existing order in place - there is NO replacement order. Wording has to
  // match, or the draft promises a "replacement" that never gets created.
  const isChangeBeforeProduction = !!context.changeBeforeProduction;
  // Shipped but not yet delivered: the shirt is physically in transit, so we
  // can no longer change or intercept it. Per Pati (2026-07-16), do NOT burn a
  // second production run on a guess for these - tell the customer it already
  // shipped and ask them to try it on when it arrives; only if it doesn't fit
  // do we then make a free replacement. SCOPED TO SHIPPED-NOT-DELIVERED ONLY:
  // in-production (not yet shipped) and delivered orders still get the instant
  // free replacement below. This is the ONE case where the "we can't change the
  // original because it already shipped" line is wanted (elsewhere Pati vetoed
  // it as noise-before-good-news) - here it IS the substance, because no
  // replacement is being created yet.
  // Match the frontend's "Shipped" signal (getTrackingStatus): a fulfilled or
  // partially-fulfilled Shopify order counts as shipped even when live carrier
  // tracking wasn't fetched (it's skipped for SIZE_EXCHANGE intents), while
  // trackingInfo gives the precise delivered/in-transit split when present.
  const fulfilledStatus = (
    context.shopifyOrder?.fulfillmentStatus || ''
  ).toLowerCase();
  const shippedSignal =
    context.trackingInfo?.hasShipped === true ||
    fulfilledStatus === 'fulfilled' ||
    fulfilledStatus === 'partial';
  const shippedNotDelivered =
    !isChangeBeforeProduction &&
    shippedSignal &&
    context.trackingInfo?.isDelivered !== true;
  const changeNoun = isChangeBeforeProduction ? 'change' : 'replacement';
  const colorNote =
    !multi && exEntities.requestedColor
      ? `The customer also asked for a different color (${exEntities.requestedColor}); the ${changeNoun} is in that new color, so confirm the new size AND color naturally (e.g. "in size L, in ${exEntities.requestedColor}"). `
      : '';
  // "Wrong size - and send it to my new place": the parsed address used to be
  // consumed only on ADDRESS_UPDATE threads, so the draft ignored it here and
  // the customer had to ask twice (Pati, 2026-07-06).
  const na = exEntities.newAddress;
  const newAddressNote =
    na && (na.address1 || na.zip || na.city)
      ? `The customer ALSO gave a NEW shipping address for the ${changeNoun} (${[
          na.address1,
          na.address2,
          na.city,
          na.region,
          na.zip,
        ]
          .filter(Boolean)
          .join(', ')}). Confirm naturally that the ${changeNoun} will ship to that new address (mention the street so they know we got it right). Do NOT say it ships to the address on file. `
      : '';

  // The opener must react to what the customer actually wrote - a fixed
  // template opener stamped on every reply reads canned (Pati's ask). The
  // template supplies the SUBSTANCE; the first sentence adapts.
  const openerNote =
    'OPENING SENTENCE: react to what the customer actually wrote, in ONE short sentence, before the confirmation. If they simply confirmed a size or thanked you, open by acknowledging that ("Perfect, thank you for confirming!"). If they described a problem or frustration, open with a brief apology. If they sounded worried, open with reassurance. The template opener below is ONE example, not a fixed phrase - do NOT open every reply with "I\'ve got you covered" or "No problem at all". ';

  // The customer already bought a replacement themselves (a second shirt in the
  // size they need), so a free replacement from us would leave them with two.
  // Offer a REFUND on the wrong-size original instead - never auto-confirm a
  // replacement (Pati, 2026-07-16). Wins over the production/shipped branches.
  if (gateEntities.alreadyReordered) {
    context.extraInstructions =
      openerNote +
      'IMPORTANT: the customer has ALREADY ordered a replacement themselves (a second shirt in the size they need), so do NOT set up or offer a free replacement - that would leave them with two shirts. ' +
      'Acknowledge warmly that they went ahead and reordered, apologize briefly that the first size was off, and offer to REFUND the wrong-size original order so they are not paying twice. ' +
      'Since our shirts are made to order, do NOT ask them to ship the wrong-size one back (they can keep or donate it). Ask them to confirm they would like the refund before you issue it. Keep it short and warm, and do NOT promise a specific refund amount or timeline.';
    return;
  }

  if (isChangeBeforeProduction) {
    // The order is edited IN PLACE before it prints (still unfulfilled).
    // No replacement, no duplicate, nothing to return. The existing order
    // number IS known, so it can be referenced (unlike a replacement).
    context.extraInstructions =
      openerNote +
      'The change is APPROVED: their EXISTING order is being updated to the new size/color before it goes to print - it is NOT a replacement, there is no second order, and nothing to return. Confirm warmly and SIMPLY, mirroring this style (adapt the item, sizes, and the order number from the facts): ' +
      '"No problem at all! I can absolutely fix that for you. I\'ve updated your order #[order number] to change the [item] from [old size] to [new size] - it\'s still unfulfilled, so I caught it just in time before it went into production. You\'re all set - no need to do anything else on your end!" ' +
      'NEVER add a keep-or-donate or send-anything-back line in this case - the order is changed in place and NO extra shirt exists (not even conditionally, no "if one was already made"). ' +
      'If the customer named a size, that is the size; if they only asked for bigger/smaller, the new size is one up/down from the size on their order. ' +
      multiNote +
      allExceptNote +
      colorNote +
      newAddressNote +
      'Keep it short and warm. Do NOT use the word "replacement" or mention a second order or returning/keeping/donating anything, and do not ask them to confirm anything.';
  } else if (shippedNotDelivered) {
    // Already on its way (shipped, not delivered): we can't change it and we
    // do NOT pre-create a replacement. Ask them to try it on first; a free
    // replacement only follows if it actually doesn't fit (Pati, 2026-07-16).
    const newSizeText = gateEntities.requestedSize
      ? `size ${gateEntities.requestedSize}`
      : gateEntities.sizeDirection === 'up'
        ? 'the larger size'
        : gateEntities.sizeDirection === 'down'
          ? 'the smaller size'
          : 'the size you need';
    const shippedColorNote = exEntities.requestedColor
      ? `If they also asked for a different color (${exEntities.requestedColor}), fold that into the same offer (the replacement would be in ${newSizeText}, in ${exEntities.requestedColor}). `
      : '';
    context.extraInstructions =
      openerNote +
      'IMPORTANT: this order has ALREADY SHIPPED and is on its way to the customer, so we can no longer change the size on it or intercept it. A replacement has NOT been created - do NOT say one is being made or is going into production. ' +
      'Explain warmly and briefly that because the order is already on its way we cannot change it now, then ask them to try it on once it arrives: if it does not fit, they just reply and we will send a free replacement in ' +
      newSizeText +
      '. ' +
      shippedColorNote +
      'Mirror this style (adapt the size and singular/plural to their order): ' +
      '"Your order is already on its way, so I\'m not able to change the size on it at this point. Go ahead and try it on when it arrives - if it doesn\'t fit, just reply here and I\'ll get a free replacement in ' +
      newSizeText +
      ' made for you right away." ' +
      'Do NOT add a keep-or-donate line, do NOT ask them to send anything back, do NOT invent a tracking number or delivery date, and do NOT ask them to confirm anything beyond trying it on. Keep it short and warm.';
  } else {
    // In production (not yet shipped) OR already delivered: a free replacement
    // order is created. Open DIRECTLY with the gold-standard confirmation -
    // never with a "we cannot change the original" preamble. A previous version
    // instructed a delivered-order opener ("Since your order has already been
    // delivered, we cannot change that original one, but...") and Pati vetoed
    // it: the customer did not ask to change the original, so explaining why
    // we can't is noise. (The shipped-not-delivered case is handled above.)
    context.extraInstructions =
      openerNote +
      'Do NOT open with an explanation of why the original order cannot be changed (no "since your order has already been delivered/shipped, we cannot change that original one" and no "since each shirt is made to order, we are not able to swap the size on this order") - the customer did not ask for that. ' +
      'The exchange is APPROVED and the free replacement is being made now. Confirm it warmly and SIMPLY, mirroring this style for the confirmation itself (adapt the size and singular/plural to their order): ' +
      '"I\'ve got you covered! I just set up a free replacement for your [shirt(s)] in [new size] - it\'s going into production today. You can keep or donate the original [shirt(s)] since having you ship them back would just create unnecessary waste and carbon emissions. You\'ll get tracking info as soon as your new shirts ship!" ' +
      'If the customer named a size, that is the size; if they only asked for bigger/smaller, it is one size up/down from the size on their order. ' +
      multiNote +
      allExceptNote +
      colorNote +
      newAddressNote +
      'Keep it short and warm, like that example. Do NOT invent an order number (we do not have the new order number yet), do NOT say "same address on file", do NOT list each product by name (just say "shirt"/"shirts") UNLESS the items are going to DIFFERENT sizes, do NOT give a specific tracking number or delivery date, and do NOT ask them to confirm anything.';
  }
}

/**
 * Build the full SuggestionContext for a thread.
 * Returns null only if the thread does not exist.
 */
export async function buildThreadSuggestionContext(
  threadId: string,
  options: BuildContextOptions = {}
): Promise<BuiltThreadContext | null> {
  const { forceFresh = false, agent, includeFeedbackExamples = true } = options;
  const warnings: string[] = [];
  let contextRefreshedAt: Date | null = null;

  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: {
      messages: {
        orderBy: { sentAt: 'asc' },
        include: {
          attachments: { select: { filename: true, mimeType: true, contentId: true } },
        },
      },
      triage: true,
    },
  });

  if (!thread) return null;

  const latestInbound = [...thread.messages]
    .reverse()
    .find((m) => m.direction === 'INBOUND');

  const context: SuggestionContext = {
    messages: thread.messages.map(
      (msg): MessageContext => ({
        from:
          msg.direction === 'INBOUND'
            ? `${thread.customerName || thread.customerEmail}`
            : 'Support Team',
        date: msg.sentAt.toISOString(),
        subject: msg.subject,
        // Feed the AI the CLEAN latest-reply text (quoted history stripped),
        // the same as the screen shows - so the actual question isn't buried
        // under walls of "On ... wrote: > ..." quotes repeated per message.
        body: latestReplyText({
          subject: msg.subject,
          bodyText: msg.bodyText,
          bodyHtml: msg.bodyHtml,
        }),
        // Non-inline attachments (customer photos etc.) - without this a
        // photo-only reply reads as an empty message and the draft claims
        // the photo "didn't come through".
        attachments: msg.attachments
          ?.filter((a) => !a.contentId) // inline images (signatures/logos) are noise
          .map((a) => a.filename),
      })
    ),
    agent,
  };

  if (thread.lastActionType && thread.lastActionAt) {
    context.recentAction = {
      type: thread.lastActionType,
      at: thread.lastActionAt.toISOString(),
      data: (thread.lastActionData as Record<string, unknown> | null) || undefined,
    };
  }

  if (thread.triage) {
    context.triage = {
      intent: thread.triage.intent,
      confidence: thread.triage.confidence,
      entities:
        (thread.triage.entities as Record<string, unknown> | null) || undefined,
    };
  }

  // --- Shopify customer + orders ---
  // ONE shared cascade with the sidebar (resolveThreadOrders): email -> guest
  // email -> name -> attached receipt -> order number in the message, each step
  // isolated so a single Shopify hiccup can't blind the draft. Falls back to the
  // local cache only when the whole live cascade comes up empty.
  let match: CustomerOrders | null = null;
  try {
    if (forceFresh) {
      const resolved = await resolveThreadOrders({
        email: thread.customerEmail,
        inferredName: thread.customerName || latestInbound?.fromName || null,
        threadId: thread.id,
        latestInboundMessageId: latestInbound?.id ?? null,
        triageEntities: thread.triage?.entities as Record<string, unknown> | null,
        hasTriageRow: !!thread.triage,
      });
      if (resolved) {
        match = {
          customer: resolved.customer,
          orders: resolved.orders,
          matchedByNameOnly: resolved.method !== 'email',
          unverifiedReason: resolved.unverifiedReason ?? undefined,
          method: resolved.method,
        };
        contextRefreshedAt = new Date();
        // Persist to the cache the sidebar also reads, so the two stay in sync.
        try {
          await prisma.customerLink.upsert({
            where: { email: thread.customerEmail },
            create: {
              email: thread.customerEmail,
              shopifyCustomerId: resolved.customer?.id,
              shopifyData: JSON.parse(
                JSON.stringify({ customer: resolved.customer || undefined, orders: resolved.orders })
              ),
              lastVerifiedAt: new Date(),
            },
            update: {
              shopifyCustomerId: resolved.customer?.id || undefined,
              shopifyData: JSON.parse(
                JSON.stringify({ customer: resolved.customer || undefined, orders: resolved.orders })
              ),
              lastVerifiedAt: new Date(),
            },
          });
        } catch (err) {
          console.error('customerLink cache upsert failed:', err);
        }
      }
    }
    if (!match) {
      match = await getCachedCustomerOrders(thread.customerEmail);
      if (match && forceFresh) {
        warnings.push('Order data is from cache - live Shopify fetch was unavailable');
      }
    }
  } catch (err) {
    console.error('Error fetching order context:', err);
  }

  if (match) {
    // The caveat must reach the MODEL, not just the operator warnings -
    // name-matched orders presented as verified fact were the dominant
    // hallucination source ("good news, it was delivered!" on the wrong order).
    // BUT only for genuinely weak matches (name / email-typo): when the match
    // came from an order number the CUSTOMER supplied (in the message or an
    // attached receipt, method 'order_name'), that IS the confirmation - a
    // draft asking them to "confirm your order number" right after they gave
    // it reads absurd. Those keep the operator warning only.
    const weakMatch =
      match.method === 'name' || match.method === 'email_typo';
    if (match.unverifiedReason) {
      warnings.push(`Order ${match.unverifiedReason}`);
      if (weakMatch) context.orderMatchUnverified = match.unverifiedReason;
    } else if (match.matchedByNameOnly && match.method !== 'order_name') {
      warnings.push(
        'Order matched by NAME only (sender email did not match) - treat as unverified; confirm the order number before promising any change'
      );
      context.orderMatchUnverified =
        'matched by NAME only - the sender email does not match the order email';
    }
    // When there are multiple orders, identify which one the request is about
    // (or flag it ambiguous) and surface the full list so the model can ask.
    // Replacements that already exist - tagged Replacement with a note naming
    // the original order. Critical: without this the draft re-promises a
    // replacement the customer already has (e.g. they email again because
    // they missed the confirmation).
    const existingReplacements = match.orders.filter((o) =>
      (o.tags || []).some((t) => t.toLowerCase() === 'replacement')
    );
    if (existingReplacements.length > 0) {
      context.replacementsAlreadyCreated = existingReplacements.map((r) => ({
        replacementOrder: r.name,
        forOrder: r.note?.match(/Replacement order for (#\d+)/i)?.[1] || '',
        createdAt: r.createdAt,
        fulfillmentStatus: r.fulfillmentStatus,
        items: r.lineItems.map(
          (li) => `${li.title}${li.variantTitle ? ` - ${li.variantTitle}` : ''}`
        ),
      }));
    }

    if (match.orders.length > 1) {
      const entities =
        (thread.triage?.entities as Record<string, string | undefined> | null) || {};
      const matchResult = matchOrderForRequest(match.orders, {
        orderNumber: entities.orderNumber,
        lineItemHint: entities.lineItemHint,
        currentSize: entities.currentSize,
      });

      context.orderCandidates = match.orders.map((o) => ({
        orderNumber: o.name,
        createdAt: o.createdAt,
        fulfillmentStatus: o.fulfillmentStatus,
        items: o.lineItems.map(
          (li) => `${li.title}${li.variantTitle ? ` - ${li.variantTitle}` : ''} (x${li.quantity})`
        ),
      }));

      const matchedOrder = matchResult.matchedOrderId
        ? match.orders.find((o) => o.id === matchResult.matchedOrderId)
        : undefined;

      context.orderMatch = {
        matchedOrderNumber: matchedOrder?.name,
        ambiguous: matchResult.ambiguous,
        reason: matchResult.reason,
      };

      // Put the matched order first so the detailed order + Printify/tracking
      // context below describe the right one.
      if (matchedOrder) {
        match.orders = [
          matchedOrder,
          ...match.orders.filter((o) => o.id !== matchedOrder.id),
        ];
      }
    }

    // Size-exchange sanity check: the customer says they have a size that
    // isn't on any of their orders (e.g. "my L is too small" but they only
    // ever bought S and M). The premise is wrong - the draft must ask to
    // clarify, not confirm a replacement. Only fires when the customer named
    // an explicit current size (a vague "too small" carries no claim to check).
    if (thread.triage?.intent === 'SIZE_EXCHANGE' && match.orders.length > 0) {
      const entities =
        (thread.triage.entities as { currentSize?: string } | null) || {};
      const claimedSize = entities.currentSize?.trim();
      if (claimedSize) {
        const sizesOf = (order: ShopifyOrder): string[] =>
          order.lineItems
            .map(
              (li) =>
                li.selectedOptions?.find((o) =>
                  o.name.toLowerCase().includes('size')
                )?.value
            )
            .filter((v): v is string => !!v);

        const sizeOnAnyOrder = match.orders.some((o) =>
          sizesOf(o).some((s) => sizesEquivalent(s, claimedSize))
        );

        if (!sizeOnAnyOrder) {
          const primary = match.orders[0];
          context.exchangeSizeIssue = {
            claimedSize,
            orderNumber: primary.name,
            orderedSizes: [...new Set(sizesOf(primary))],
          };
          warnings.push(
            `Customer says they have size ${claimedSize}, but ${primary.name} has no ${claimedSize} (sizes: ${[...new Set(sizesOf(primary))].join(', ') || 'none'}) - the draft asks to clarify instead of confirming`
          );
        }
      }
    }

    if (match.customer) {
      Object.assign(context, buildShopifyContext(match.customer, match.orders));
    } else if (match.orders.length > 0) {
      const order = match.orders[0];
      context.shopifyOrder = {
        orderNumber: order.name,
        status: order.financialStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        createdAt: order.createdAt,
        totalPrice: order.totalPrice,
        currency: order.totalPriceCurrency,
        lineItems: order.lineItems.map((li) => ({
          title: li.title + (li.variantTitle ? ` - ${li.variantTitle}` : ''),
          quantity: li.quantity,
        })),
        trackingNumber: order.fulfillments[0]?.trackingNumber,
        trackingUrl: order.fulfillments[0]?.trackingUrl,
        shippingAddress: formatAddressLine(order.shippingAddress),
        billingAddressOnFile: billingIfDiffers(order),
        refundedAmount: refundedIfAny(order),
      };
    }

    // Address-change requests: if the address the customer asked for already
    // matches the order's current shipping address, nothing needs changing
    // (common when they cancelled and re-ordered with the corrected address
    // themselves). Runs AFTER the branch above so it applies whether or not the
    // customer was identified (the customer-matched path sets shopifyOrder too).
    if (
      context.shopifyOrder &&
      thread.triage?.intent === 'ADDRESS_UPDATE' &&
      match.orders.length > 0
    ) {
      const reqAddr = (
        thread.triage.entities as {
          newAddress?: { address1?: string; zip?: string; city?: string };
        } | null
      )?.newAddress;
      const cur = match.orders[0].shippingAddress as
        | { address1?: string; zip?: string; city?: string }
        | undefined;
      if (reqAddr && cur) {
        const norm = (s?: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const streetNo = (s?: string) => (s || '').match(/\d+/)?.[0] || '';
        const reqA1 = norm(reqAddr.address1);
        const curA1 = norm(cur.address1);
        const reqZip = norm(reqAddr.zip);
        const curZip = norm(cur.zip);
        // Match on the full normalized street, OR on street-number + zip + city
        // (abbreviation-proof: "Drive" vs "Dr" won't break it).
        const exactStreet =
          reqA1 !== '' && reqA1 === curA1 && (!reqZip || !curZip || reqZip === curZip);
        const looseStreet =
          streetNo(reqAddr.address1) !== '' &&
          streetNo(reqAddr.address1) === streetNo(cur.address1) &&
          reqZip !== '' &&
          reqZip === curZip &&
          norm(reqAddr.city) === norm(cur.city);
        if (exactStreet || looseStreet) {
          context.shopifyOrder.addressChangeNote =
            "IMPORTANT: the address the customer asked for ALREADY matches this order's current shipping address - no change is needed. Reassure them their order is already set to ship to that address. Do NOT claim the order is in production, delivered, or that the address cannot be changed.";
        }
      }
    }

    // --- Printify production status for the most recent order ---
    if (match.orders.length > 0) {
      const order = match.orders[0];
      const candidates = [
        order.name,
        order.name?.replace('#', ''),
        order.orderNumber?.toString(),
        order.id?.replace('gid://shopify/Order/', ''),
      ].filter(Boolean) as string[];

      try {
        const cachedOrder = await prisma.printifyOrderCache.findFirst({
          where: {
            OR: [
              { externalId: { in: candidates } },
              { label: { in: candidates } },
              { metadataShopOrderId: { in: candidates } },
              { metadataShopOrderLabel: { in: candidates } },
            ],
          },
          orderBy: { updatedAt: 'desc' },
        });

        let printifyOrder = cachedOrder?.data as unknown as PrintifyOrder | undefined;

        // Live refresh of the matched Printify order. This sits on the
        // operator's open-thread path, so it must never wait out a Printify
        // rate-limit storm: past the deadline we fall back to the cached copy
        // (the sync keeps it near-fresh) instead of leaving the draft spinner
        // hanging.
        if (forceFresh && cachedOrder) {
          try {
            const printifyClient = await createPrintifyClient();
            const fresh = printifyClient
              ? await Promise.race([
                  printifyClient.getOrder(cachedOrder.id),
                  new Promise<null>((_, reject) =>
                    setTimeout(
                      () => reject(new Error('Printify live refresh timed out (12s), using cache')),
                      12_000
                    ).unref?.()
                  ),
                ])
              : null;
            if (fresh) {
              printifyOrder = fresh;
              await prisma.printifyOrderCache.update({
                where: { id: cachedOrder.id },
                data: {
                  status: fresh.status,
                  data: JSON.parse(JSON.stringify(fresh)),
                  lastSyncedAt: new Date(),
                },
              });
            }
          } catch (err) {
            console.error('Live Printify refresh failed, using cache:', err);
          }
        }

        if (printifyOrder) {
          Object.assign(context, buildPrintifyContext(printifyOrder));

          // If this is a change/exchange request AND the order hasn't been sent
          // to production yet, we can change the order itself before it prints
          // (cancel + recreate on Printify, edit the Shopify order) - no free
          // replacement, no duplicate. Tell the draft so it confirms the change
          // instead of offering a "keep the original" replacement.
          if (
            thread.triage?.intent === 'SIZE_EXCHANGE' &&
            PrintifyClient.canCancelOrder(printifyOrder)
          ) {
            context.changeBeforeProduction = { orderNumber: order.name };
          }

          // --- Carrier tracking for the latest shipment ---
          const shipment = printifyOrder.shipments?.[0];
          if (shipment?.number && shipment?.carrier) {
            const cachedTracking = await prisma.trackingCache.findUnique({
              where: {
                trackingNumber_carrier: {
                  trackingNumber: shipment.number,
                  carrier: shipment.carrier,
                },
              },
            });

            let tracking = cachedTracking?.data as unknown as TrackingResult | undefined;
            const trackingIsFinal =
              tracking?.status === 'delivered' || tracking?.status === 'expired';

            // Metered API: live carrier fetch only when the reply actually
            // hinges on shipping state; other intents use whatever is cached
            const triageIntent = thread.triage?.intent;
            const lastInboundMsg = [...thread.messages]
              .reverse()
              .find((m) => m.direction === 'INBOUND');
            const inboundText = (lastInboundMsg?.bodyText || '').toLowerCase();
            const shippingRelevant = needsLiveTracking(triageIntent, inboundText);
            // A non-final status (in transit / out for delivery) can advance to
            // delivered within the freshness window, so for a shipping reply we
            // pull live truth regardless of cache age - only a FINAL status
            // (delivered/expired) skips the call.
            if (forceFresh && shippingRelevant && !trackingIsFinal) {
              try {
                const trackingClient = await createTrackingMoreClient();
                if (trackingClient) {
                  const fresh = await trackingClient.trackShipment(
                    shipment.number,
                    shipment.carrier
                  );
                  tracking = fresh;
                  await prisma.trackingCache.upsert({
                    where: {
                      trackingNumber_carrier: {
                        trackingNumber: shipment.number,
                        carrier: shipment.carrier,
                      },
                    },
                    create: {
                      trackingNumber: shipment.number,
                      carrier: shipment.carrier,
                      data: fresh as object,
                      fetchedAt: new Date(),
                    },
                    update: {
                      data: fresh as object,
                      fetchedAt: new Date(),
                    },
                  });
                }
              } catch (err) {
                console.error('Live tracking refresh failed, using cache:', err);
              }
            }

            if (tracking) {
              Object.assign(context, buildTrackingContext(tracking, printifyOrder));
            }
          }
        }
      } catch (err) {
        console.error('Error building Printify/tracking context:', err);
      }
    }

    // --- Live carrier check (DHL official API): ONLY for shipping-status /
    // lost-package inquiries - the carrier is the source of truth and can
    // also provide a proof-of-delivery document ---
    const intent = thread.triage?.intent;
    const lastInbound = [...thread.messages]
      .reverse()
      .find((m) => m.direction === 'INBOUND');
    const lastText = (lastInbound?.bodyText || '').toLowerCase();
    const wantsLiveTracking = needsLiveTracking(intent, lastText);
    const liveTrackingNumber =
      context.trackingInfo?.trackingNumber ||
      context.shopifyOrder?.trackingNumber;
    const liveCarrier = (context.trackingInfo?.carrier || '').toLowerCase();
    if (
      wantsLiveTracking &&
      liveTrackingNumber &&
      (liveCarrier.includes('dhl') || !context.trackingInfo)
    ) {
      const live = await fetchDhlLiveTracking(liveTrackingNumber);
      if (live && live.statusCode !== 'unknown') {
        const liveStatusMap: Record<string, string> = {
          'pre-transit': 'Label created - NOT shipped yet',
          transit: 'Shipped, on the way',
          delivered: 'Delivered',
          failure: 'Delivery issue',
        };
        const hasShippedLive =
          live.statusCode === 'transit' || live.statusCode === 'delivered';

        // DHL eCommerce often scans only the FIRST leg, then hands the parcel
        // to USPS for final delivery - so DHL's own feed can sit on "in transit"
        // while USPS already delivered (Printify/TrackingMore see that via the
        // last leg). Never let DHL DOWNGRADE a status another source already
        // advanced; apply it only when it moves the status forward, or signals
        // a delivery exception worth surfacing.
        const rank = (info?: { isDelivered?: boolean; hasShipped?: boolean }) =>
          info?.isDelivered ? 4 : info?.hasShipped ? 2 : 0;
        const dhlRank =
          live.statusCode === 'delivered'
            ? 4
            : live.statusCode === 'transit'
              ? 2
              : 0;
        const isException = live.statusCode === 'failure';

        if (dhlRank >= rank(context.trackingInfo) || isException) {
          context.trackingInfo = {
            ...(context.trackingInfo || {
              carrier: 'DHL eCommerce',
              trackingNumber: liveTrackingNumber,
              isDelivered: false,
              hasShipped: false,
              status: '',
            }),
            status: `${liveStatusMap[live.statusCode] || live.statusText} (live from carrier${live.location ? `, ${live.location}` : ''})`,
            latestEvent: live.events[0]
              ? `${live.events[0].description}${live.events[0].location ? ` - ${live.events[0].location}` : ''} (${live.events[0].timestamp})`
              : context.trackingInfo?.latestEvent,
            lastUpdate: live.timestamp || context.trackingInfo?.lastUpdate,
            estimatedDelivery:
              live.estimatedDelivery || context.trackingInfo?.estimatedDelivery,
            isDelivered: live.statusCode === 'delivered',
            deliveredAt:
              live.statusCode === 'delivered' && live.timestamp
                ? new Date(live.timestamp).toLocaleString('en-US', {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })
                : context.trackingInfo?.deliveredAt,
            hasShipped: hasShippedLive,
            proofOfDeliveryUrl:
              live.proofOfDeliveryUrl || context.trackingInfo?.proofOfDeliveryUrl,
          };
        } else if (
          live.proofOfDeliveryUrl &&
          context.trackingInfo &&
          !context.trackingInfo.proofOfDeliveryUrl
        ) {
          // DHL is behind the real status but still handed us a POD doc - keep
          // the more-advanced status, just attach the proof.
          context.trackingInfo.proofOfDeliveryUrl = live.proofOfDeliveryUrl;
        }
      }
    }

    // --- Shopify's own fulfillment tracking: fills the gaps TrackingMore
    // leaves (stale cache, exhausted quota) with shipment events + the
    // estimated delivery date Shopify computes itself ---
    const matchedOrder = match.orders[0];
    if (
      matchedOrder &&
      matchedOrder.fulfillments?.length > 0 &&
      (!context.trackingInfo || !context.trackingInfo.estimatedDelivery)
    ) {
      try {
        const shopifyClient = await createShopifyClient();
        const ft = shopifyClient
          ? await shopifyClient.getOrderFulfillmentTracking(matchedOrder.id)
          : null;
        if (ft) {
          const latest = ft.events[0];
          const SHIPPED_STATUSES = new Set([
            'IN_TRANSIT',
            'OUT_FOR_DELIVERY',
            'ATTEMPTED_DELIVERY',
            'READY_FOR_PICKUP',
            'DELIVERED',
          ]);
          const statusText: Record<string, string> = {
            LABEL_PRINTED: 'Label created - NOT shipped yet',
            LABEL_PURCHASED: 'Label created - NOT shipped yet',
            CONFIRMED: 'Confirmed by carrier - not yet picked up',
            IN_TRANSIT: 'Shipped, on the way',
            OUT_FOR_DELIVERY: 'Out for delivery',
            ATTEMPTED_DELIVERY: 'Delivery attempted',
            READY_FOR_PICKUP: 'Ready for pickup',
            DELIVERED: 'Delivered',
            FAILURE: 'Delivery issue',
          };
          const eta = ft.estimatedDeliveryAt
            ? new Date(ft.estimatedDeliveryAt).toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })
            : undefined;

          if (!context.trackingInfo && latest) {
            // No TrackingMore data at all - build from Shopify alone
            context.trackingInfo = {
              status: statusText[latest.status] || latest.status,
              carrier: ft.trackingCompany || 'carrier',
              trackingNumber: ft.trackingNumber || '',
              estimatedDelivery: eta,
              lastUpdate: latest.happenedAt,
              latestEvent: `${statusText[latest.status] || latest.status} (${latest.happenedAt})`,
              isDelivered: latest.status === 'DELIVERED',
              hasShipped: SHIPPED_STATUSES.has(latest.status),
            };
          } else if (context.trackingInfo) {
            // Fill the holes in existing tracking data
            if (!context.trackingInfo.estimatedDelivery && eta) {
              context.trackingInfo.estimatedDelivery = eta;
            }
            if (latest && SHIPPED_STATUSES.has(latest.status) && !context.trackingInfo.hasShipped) {
              // Shopify saw carrier movement that the stale cache missed
              context.trackingInfo.hasShipped = true;
              context.trackingInfo.status = statusText[latest.status] || latest.status;
              context.trackingInfo.latestEvent = `${statusText[latest.status] || latest.status} (${latest.happenedAt})`;
              context.trackingInfo.isDelivered = latest.status === 'DELIVERED';
            }
          }
        }
      } catch (err) {
        console.error('Shopify fulfillment tracking fill failed:', err);
      }
    }

    // No carrier ETA yet (the order has not shipped - the common made-to-order
    // case where customers ask "when will it arrive?"): give a computed window
    // from the order date + our timeline (up to 4 business days production, then
    // 2-5 business days shipping). The carrier ETA always wins once it exists.
    const etaOrder = match.orders[0];
    if (
      context.shopifyOrder &&
      etaOrder?.createdAt &&
      !context.trackingInfo?.estimatedDelivery &&
      !context.trackingInfo?.isDelivered &&
      // An address-update reply just confirms the change - it should not quote a
      // (re)computed arrival estimate. The existing confirmation is good as-is.
      intent !== 'ADDRESS_UPDATE' &&
      // Only quote specific dates once the order has SHIPPED. While it is still
      // in production our window can conflict with Printify's own UI estimate
      // (which is not exposed via the API), so for unshipped orders we quote the
      // made-to-order timeline instead of dates (see prompt rule 8).
      context.trackingInfo?.hasShipped === true
    ) {
      const created = new Date(etaOrder.createdAt);
      if (!Number.isNaN(created.getTime())) {
        // Full production time if not shipped, 1 prod day if shipped; anchored
        // to today so an older/delayed order never quotes a past date. See
        // estimateArrivalWindow.
        const { earliest, latest } = estimateArrivalWindow(
          created,
          context.trackingInfo?.hasShipped === true
        );
        const fmt = (d: Date) =>
          d.toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
          });
        context.shopifyOrder.estimatedDeliveryWindow = `${fmt(earliest)} - ${fmt(latest)}`;
      }
    }
  }

  // --- Store knowledge (brand voice, avatar, Shopify pages/policies, catalog) ---
  // The full product list is only worth its tokens for product/availability
  // questions (intent OTHER or pre-purchase with no order context).
  try {
    const includeProductCatalog =
      !thread.triage ||
      thread.triage.intent === 'OTHER' ||
      thread.triage.intent === 'PRODUCT_QUESTION';
    const knowledge = await getKnowledgeBlocks({ includeProductCatalog });
    if (knowledge.length > 0) {
      context.knowledge = knowledge;
    }
  } catch (err) {
    console.error('Error loading store knowledge:', err);
  }

  // --- Few-shot examples come ONLY from Pati's hand-curated GOLDEN_TEMPLATES,
  // matched to the triaged intent. We deliberately do NOT learn from past
  // replies in the DB or from operator edits (suggestionFeedback): pulling
  // uncurated previous answers drifted the voice and reintroduced the
  // verbosity we want gone. The curated templates are the single source of
  // style. ---
  const fsIntent = thread.triage?.intent;
  // Only attach templates when triage is reasonably sure of the intent: the
  // "mirror these closely" instruction amplifies a misclassification (a
  // size-exchange thread once got the POSITIVE_FEEDBACK template nearly
  // verbatim). Below the bar the model writes from the rules alone.
  const fsConfident = (thread.triage?.confidence ?? 0) >= 0.7;
  if (includeFeedbackExamples && fsIntent && fsConfident) {
    // Pass the customer's latest message so an intent with many templates only
    // contributes its closest-matching examples (keeps the prompt lean).
    const query = latestInbound ? latestReplyText(latestInbound) : undefined;
    const examples = goldenTemplatesForIntent(fsIntent, query);
    if (examples.length > 0) context.fewShotExamples = examples;
  }

  // Size exchanges: phrase the draft for the moment the operator approves the
  // exchange (the approve button creates the replacement / edits the order and
  // sends this reply in one step). Ported from the retired pre-draft pipeline -
  // this now runs on the LIVE suggest path too, which previously drafted
  // approved exchanges without any of this wording.
  applyExchangeInstructions(context, thread, latestInbound?.sentAt ?? null);

  return {
    context,
    warnings,
    latestInboundMessageId: latestInbound?.id || null,
    contextRefreshedAt,
  };
}
