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
import { pendingEscalationsWhere } from '@/lib/queues';
import { createPrintifyClient } from '@/lib/printify';
import { createShopifyClient } from '@/lib/shopify';
import { claimWindowFromDelivery, latestDeliveredAt } from '@/lib/escalations/deadline';

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
        where: pendingEscalationsWhere(),
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

    // "Already handled" detection so a row can show it's done before the
    // operator ticks it: a Shopify refund on the order, or a replacement
    // already created (reusing the late-orders signals - support-desk relinks
    // + Shopify "Replacement"-tagged orders whose note references the order #).
    const digitsOf = (s: string | null | undefined) => (s || '').replace(/\D/g, '');

    // Relinks for these orders (by order name OR original printify id).
    const relinkDigits = new Set<string>();
    const relinkPids = new Set<string>();
    try {
      const relinks = await prisma.orderRelink.findMany({
        where: {
          OR: [
            { shopifyOrderName: { in: pending.map((e) => e.orderNumber) } },
            {
              originalPrintifyOrderId: {
                in: pending.map((e) => e.printifyOrderId).filter((x): x is string => !!x),
              },
            },
          ],
        },
        select: { shopifyOrderName: true, originalPrintifyOrderId: true },
      });
      for (const r of relinks) {
        if (r.shopifyOrderName) relinkDigits.add(digitsOf(r.shopifyOrderName));
        if (r.originalPrintifyOrderId) relinkPids.add(r.originalPrintifyOrderId);
      }
    } catch (err) {
      console.warn('[escalations] relink lookup failed:', err);
    }

    // Shopify Replacement orders -> the order-number digits they reference.
    const replacedDigits = new Set<string>();
    try {
      if (shopifyClient && pending.length > 0) {
        const sinceISO = new Date(Date.now() - 90 * 86400 * 1000).toISOString();
        const repls = await shopifyClient.getReplacementOrders(sinceISO);
        for (const r of repls) {
          const m = (r.note || '').match(/for\s+#?(\d{3,})/i);
          if (m) replacedDigits.add(m[1]);
        }
      }
    } catch (err) {
      console.warn('[escalations] replacement-order lookup failed:', err);
    }

    // Printify's DISPLAY order number (app_order_id, e.g. "19269685.5884") -
    // what we reference to Printify support. Looked up from the order cache by
    // the stored Printify order id.
    const printifyNumbers = new Map<string, string>();
    // Delivery date per Printify order id, to compute the 30-day claim window.
    const deliveredAtByPid = new Map<string, string>();
    try {
      const pids = pending
        .map((e) => e.printifyOrderId)
        .filter((x): x is string => !!x);
      if (pids.length > 0) {
        const cached = await prisma.printifyOrderCache.findMany({
          where: { id: { in: pids } },
          select: { id: true, data: true },
        });
        for (const c of cached) {
          const data = c.data as {
            app_order_id?: string;
            shipments?: { delivered_at?: string | null }[];
          } | null;
          if (data?.app_order_id) printifyNumbers.set(c.id, data.app_order_id);
          const delivered = latestDeliveredAt(data?.shipments);
          if (delivered) deliveredAtByPid.set(c.id, delivered);
        }
      }
    } catch (err) {
      console.warn('[escalations] printify-number lookup failed:', err);
    }

    const now = new Date();

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
      const d = digitsOf(e.orderNumber);
      const replacementSent =
        (!!e.printifyOrderId && relinkPids.has(e.printifyOrderId)) ||
        (!!d && (relinkDigits.has(d) || replacedDigits.has(d)));
      const printifyOrderNumber = e.printifyOrderId
        ? printifyNumbers.get(e.printifyOrderId) || null
        : null;
      const deliveredAt = e.printifyOrderId
        ? deliveredAtByPid.get(e.printifyOrderId) || null
        : null;
      const claimWindow = claimWindowFromDelivery(deliveredAt, now);
      return {
        ...e,
        printifyOrderNumber,
        claimWindow,
        detected: { refunded, replacementSent },
      };
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

    // Auto-capture the customer's photos: image attachments on the thread's
    // inbound messages (served at /api/attachments/<id>), merged with any
    // explicitly passed.
    const photoUrls = [...(body.photoUrls || [])];
    if (body.threadId) {
      try {
        const atts = await prisma.attachment.findMany({
          where: {
            message: { threadId: body.threadId, direction: 'INBOUND' },
            mimeType: { startsWith: 'image/' },
          },
          select: { id: true },
          take: 12,
        });
        for (const a of atts) {
          const url = `/api/attachments/${a.id}`;
          if (!photoUrls.includes(url)) photoUrls.push(url);
        }
      } catch (err) {
        console.warn('[escalations] photo capture failed:', err);
      }
    }

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
        photoUrls,
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
