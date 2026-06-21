/**
 * Printify Escalations - defect / confirmed-not-delivered cases the operator
 * has answered to the customer and now needs to action on Printify (a free
 * replacement or a refund), handled in bulk from the Needs Attention tab.
 *
 * GET  -> pending + recently-done escalations, with linkout config and
 *         best-effort "already handled" detection (Shopify refund / replacement).
 * POST -> create one (from the thread's "Escalate to Printify" button).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { createPrintifyClient } from '@/lib/printify';
import { createShopifyClient } from '@/lib/shopify';

const createSchema = z.object({
  threadId: z.string().optional(),
  orderNumber: z.string().min(1),
  shopifyOrderId: z.string().optional(),
  printifyOrderId: z.string().optional(),
  customerName: z.string().optional(),
  customerEmail: z.string().optional(),
  resolution: z.enum(['REPLACEMENT', 'REFUND']),
  issue: z.string().min(1),
  photoUrls: z.array(z.string()).optional(),
});

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const [pending, recentlyDone] = await Promise.all([
      prisma.printifyEscalation.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      prisma.printifyEscalation.findMany({
        where: { status: 'DONE' },
        orderBy: { resolvedAt: 'desc' },
        take: 20,
      }),
    ]);

    // Linkout config (same source the context route uses).
    const printifyClient = await createPrintifyClient();
    const printifyShopId = printifyClient?.getShopId() || null;
    const shopifyClient = await createShopifyClient();
    const storeDomain = shopifyClient?.getStoreDomain() || null;

    // Best-effort "already handled" detection so a row can show it's done even
    // before the operator ticks it. v1 detects a Shopify refund on the order
    // (cheap + reliable); replacement-sent detection is a planned follow-up
    // that reuses the late-orders replacement logic.
    const detect = async (e: (typeof pending)[number]) => {
      let refunded = false;
      try {
        if (e.shopifyOrderId && shopifyClient) {
          const order = await shopifyClient.getOrderById(e.shopifyOrderId);
          if (order) refunded = parseFloat(order.totalRefunded || '0') > 0;
        }
      } catch {
        // best-effort only
      }
      return { ...e, detected: { refunded } };
    };

    const pendingEnriched = await Promise.all(pending.map(detect));

    return NextResponse.json({
      pending: pendingEnriched,
      recentlyDone,
      printifyShopId,
      storeDomain,
    });
  } catch (err) {
    console.error('[escalations] GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!hasPermission(session.user.role, 'CHANGE_STATUS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = createSchema.parse(await request.json());

    const escalation = await prisma.printifyEscalation.create({
      data: {
        threadId: body.threadId,
        orderNumber: body.orderNumber,
        shopifyOrderId: body.shopifyOrderId,
        printifyOrderId: body.printifyOrderId,
        customerName: body.customerName,
        customerEmail: body.customerEmail,
        resolution: body.resolution,
        issue: body.issue,
        photoUrls: body.photoUrls || [],
        createdBy: session.user.name || session.user.email || null,
      },
    });

    return NextResponse.json({ success: true, escalation });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request', details: err.issues }, { status: 400 });
    }
    console.error('[escalations] POST error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
