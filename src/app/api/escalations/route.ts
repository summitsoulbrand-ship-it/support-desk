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

// --- Auto-suggest a replacement link -----------------------------------------
// Titles/names normalized to token sets so "Easily Distracted By Rocks" matches
// regardless of case/punctuation. A confident suggestion needs BOTH the customer
// name and the design title to line up, and exactly one such candidate.
const normTokens = (s: string | null | undefined) =>
  (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);

// Same soft name check the picker uses: shared token + matching last name (or
// two shared tokens). Missing names return true so we never over-reject on gaps.
function nameLooseMatch(a?: string | null, b?: string | null): boolean {
  const ta = normTokens(a).filter((t) => /[a-z]/.test(t));
  const tb = normTokens(b).filter((t) => /[a-z]/.test(t));
  if (!ta.length || !tb.length) return false; // for suggestions, no name = no confidence
  const setB = new Set(tb);
  const shared = ta.filter((t) => setB.has(t));
  return shared.length >= 1 && (ta[ta.length - 1] === tb[tb.length - 1] || shared.length >= 2);
}

// The two designs share a title when one title's meaningful tokens are a subset
// of the other's (ignores the " Premium" suffix and size/color variant tokens).
function titleMatch(a: Set<string>, b: Set<string>): boolean {
  const strip = (s: Set<string>) =>
    new Set([...s].filter((t) => t !== 'premium' && t.length >= 3));
  const sa = strip(a);
  const sb = strip(b);
  if (sa.size === 0 || sb.size === 0) return false;
  const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  let shared = 0;
  for (const t of small) if (big.has(t)) shared++;
  // Full containment of the smaller title, and at least two real words shared
  // (one-word overlaps like "rock" are too common to trust).
  return shared === small.size && shared >= 2;
}

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
    // Original order's design titles + customer name, for the auto-suggest match.
    const origTitlesByPid = new Map<string, Set<string>>();
    const origNameByPid = new Map<string, string>();
    const titlesOf = (data: {
      line_items?: { metadata?: { title?: string } }[];
    } | null): Set<string> => {
      const set = new Set<string>();
      for (const li of data?.line_items || [])
        for (const t of normTokens(li.metadata?.title)) set.add(t);
      return set;
    };
    const nameOf = (data: {
      address_to?: { first_name?: string; last_name?: string };
    } | null): string =>
      data?.address_to
        ? `${data.address_to.first_name || ''} ${data.address_to.last_name || ''}`.trim()
        : '';
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
            line_items?: { metadata?: { title?: string } }[];
            address_to?: { first_name?: string; last_name?: string };
          } | null;
          if (data?.app_order_id) printifyNumbers.set(c.id, data.app_order_id);
          const delivered = latestDeliveredAt(data?.shipments);
          if (delivered) deliveredAtByPid.set(c.id, delivered);
          origTitlesByPid.set(c.id, titlesOf(data));
          const nm = nameOf(data);
          if (nm) origNameByPid.set(c.id, nm);
        }
      }
    } catch (err) {
      console.warn('[escalations] printify-number lookup failed:', err);
    }

    // Auto-suggest: for each unlinked REPLACEMENT, find a recently hand-made
    // Printify order that unambiguously matches (same customer name AND design
    // title, exactly one candidate). Anything ambiguous falls back to the manual
    // picker - a wrong link would send tracking to the wrong customer.
    const suggestByEscId = new Map<
      string,
      { printifyOrderId: string; orderNumber: string; customerName: string; items: string[] }
    >();
    try {
      const needsSuggest = pending.filter(
        (e) => e.resolution === 'REPLACEMENT' && e.shopifyOrderId
      );
      if (needsSuggest.length > 0) {
        // Newest hand-made orders are the only plausible replacements.
        const poolRows = await prisma.printifyOrderCache.findMany({
          orderBy: { createdAt: 'desc' },
          take: 300,
          select: { id: true, data: true, label: true, createdAt: true },
        });
        // Exclude any Printify order already linked to something.
        const linkedNewIds = new Set(
          (
            await prisma.orderRelink.findMany({ select: { printifyOrderId: true } })
          ).map((r) => r.printifyOrderId)
        );
        const pool = poolRows
          .filter((r) => !linkedNewIds.has(r.id))
          .map((r) => {
            const data = r.data as {
              app_order_id?: string;
              line_items?: { metadata?: { title?: string } }[];
              address_to?: { first_name?: string; last_name?: string };
            } | null;
            const items = (data?.line_items || [])
              .map((li) => li.metadata?.title || '')
              .filter(Boolean);
            return {
              id: r.id,
              orderNumber: data?.app_order_id || r.label || r.id,
              name: nameOf(data),
              titles: titlesOf(data),
              items,
              createdAt: r.createdAt,
            };
          });

        for (const e of needsSuggest) {
          const origTitles =
            (e.printifyOrderId && origTitlesByPid.get(e.printifyOrderId)) || new Set<string>();
          if (origTitles.size === 0) continue; // no title to match on -> stay manual
          const wantName =
            e.customerName ||
            (e.printifyOrderId && origNameByPid.get(e.printifyOrderId)) ||
            '';
          // Grace of 1 day before the escalation was raised, to allow a
          // same-day replacement whose clock runs a little ahead.
          const floor = new Date(e.createdAt.getTime() - 86400 * 1000);
          const hits = pool.filter(
            (c) =>
              c.id !== e.printifyOrderId &&
              c.createdAt >= floor &&
              nameLooseMatch(wantName, c.name) &&
              titleMatch(origTitles, c.titles)
          );
          if (hits.length === 1) {
            const h = hits[0];
            suggestByEscId.set(e.id, {
              printifyOrderId: h.id,
              orderNumber: h.orderNumber,
              customerName: h.name,
              items: h.items,
            });
          }
        }
      }
    } catch (err) {
      console.warn('[escalations] auto-suggest match failed:', err);
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
      // Only surface a suggestion when nothing is linked yet.
      const suggestedLink = replacementSent ? null : suggestByEscId.get(e.id) || null;
      return {
        ...e,
        printifyOrderNumber,
        claimWindow,
        detected: { refunded, replacementSent },
        suggestedLink,
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
