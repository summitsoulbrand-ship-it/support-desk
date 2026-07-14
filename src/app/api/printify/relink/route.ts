/**
 * Thread-independent "Link Printify" recorder.
 *
 * The customer sidebar links a hand-made Printify replacement to its original
 * Shopify order through the thread action `mark_exchange_handled`, which needs a
 * thread. The Printify Escalations (Needs Attention) and Late Deliveries views
 * work off orders that may have no thread, so they post here instead. The
 * essential write is identical: record an OrderRelink so a shipment on the new
 * Printify order pushes its tracking onto the ORIGINAL Shopify order.
 *
 * If a threadId is supplied we also clear that thread's stale "approve exchange"
 * panel, exactly like the sidebar path - best-effort, never fatal.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { logAction } from '@/lib/audit';

const bodySchema = z.object({
  // The hand-made replacement's Printify cache id (row.id from the search).
  newPrintifyOrderId: z.string().min(1),
  // The original Shopify order the tracking should flow back to.
  shopifyOrderId: z.string().min(1),
  shopifyOrderName: z.string().nullish(),
  // The original Printify order id, when we have it (optional).
  originalPrintifyOrderId: z.string().nullish(),
  // The display order number, for the audit summary / label.
  replacementLabel: z.string().nullish(),
  // When the source view has a thread, clear its stale exchange panel too.
  threadId: z.string().nullish(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!hasPermission(session.user.role, 'CHANGE_STATUS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = bodySchema.parse(await request.json());

    // Label the replacement off the Printify cache when we can; not fatal if the
    // cache hasn't synced it yet - the relink heals on the next webhook.
    const cached = await prisma.printifyOrderCache.findUnique({
      where: { id: body.newPrintifyOrderId },
    });
    const replacementLabel =
      body.replacementLabel ||
      cached?.metadataShopOrderLabel ||
      cached?.label ||
      `Printify order ${body.newPrintifyOrderId}`;

    // Record the link (same upsert the sidebar and automated recreate use).
    // Keyed on the new Printify order id, so re-linking is harmless, never a dup.
    const relink = await prisma.orderRelink.upsert({
      where: { printifyOrderId: body.newPrintifyOrderId },
      create: {
        printifyOrderId: body.newPrintifyOrderId,
        originalPrintifyOrderId: body.originalPrintifyOrderId || null,
        shopifyOrderId: body.shopifyOrderId,
        shopifyOrderName: body.shopifyOrderName || null,
        reason: 'REPLACEMENT',
        status: 'PENDING',
      },
      update: {
        shopifyOrderId: body.shopifyOrderId,
        shopifyOrderName: body.shopifyOrderName || null,
        originalPrintifyOrderId: body.originalPrintifyOrderId || null,
        reason: 'REPLACEMENT',
      },
    });

    // If this came from a thread-backed order, clear the stale exchange panel so
    // the sidebar doesn't offer to make the replacement again. Best-effort.
    if (body.threadId) {
      try {
        await prisma.thread.update({
          where: { id: body.threadId },
          data: {
            lastActionType: 'replacement_created',
            lastActionAt: new Date(),
            lastActionData: {
              orderId: body.shopifyOrderId,
              replacementOrderName: replacementLabel,
              handledExternally: true,
              newPrintifyOrderId: body.newPrintifyOrderId,
            },
          },
        });
      } catch (err) {
        console.warn('[printify/relink] could not clear thread panel:', err);
      }
    }

    await logAction({
      threadId: body.threadId || null,
      userId: session.user.id,
      userName: session.user.name || session.user.email || 'Unknown',
      action: 'mark_exchange_handled',
      summary: `Linked hand-made Printify replacement ${replacementLabel} to ${body.shopifyOrderName || body.shopifyOrderId}`,
      orderName: body.shopifyOrderName || null,
      metadata: {
        forOrderId: body.shopifyOrderId,
        newPrintifyOrderId: body.newPrintifyOrderId,
        relinkId: relink.id,
      },
    });

    return NextResponse.json({
      success: true,
      relinkId: relink.id,
      replacementLabel,
      summary: `Linked ${replacementLabel} - tracking will flow to ${body.shopifyOrderName || 'the original order'} when it ships.`,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request', details: err.issues },
        { status: 400 }
      );
    }
    console.error('[printify/relink] error:', err);
    return NextResponse.json(
      { error: 'Failed to link the Printify order' },
      { status: 500 }
    );
  }
}
