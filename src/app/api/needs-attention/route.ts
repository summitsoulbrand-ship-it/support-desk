/**
 * Needs Attention queue - one place that surfaces anything stuck:
 *  - threads manually escalated (e.g. in-production address change)
 *  - AI drafts that failed to generate
 *  - Printify relinks that failed to push fulfillment back
 *  - Printify reprints nobody submitted, so they are not printing
 *
 * GET  -> the aggregated list (+ count)
 * POST { threadId } -> resolve a manual escalation
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import {
  manualAttentionWhere,
  failedDraftsWhere,
  failedRelinksWhere,
} from '@/lib/queues';
import { createPrintifyClient } from '@/lib/printify';
import { findReprintsOnHold, holdWords, printifyOrderUrl } from '@/lib/printify/reprint-watch';

export interface AttentionItem {
  type: 'manual' | 'draft_failed' | 'relink_failed' | 'reprint_on_hold';
  id: string;
  threadId?: string | null;
  title: string;
  detail?: string | null;
  /** Where to fix it, when that is outside the desk (e.g. the Printify order). */
  url?: string | null;
  createdAt: string;
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const [manualThreads, failedDrafts, failedRelinks, reprintsOnHold] = await Promise.all([
      prisma.thread.findMany({
        where: manualAttentionWhere(),
        select: {
          id: true,
          subject: true,
          customerName: true,
          customerEmail: true,
          manualReason: true,
          lastActionAt: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
      prisma.aiDraft.findMany({
        where: failedDraftsWhere(),
        select: {
          threadId: true,
          error: true,
          updatedAt: true,
          thread: { select: { subject: true, customerName: true, status: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
      prisma.orderRelink.findMany({
        where: failedRelinksWhere(),
        select: {
          id: true,
          shopifyOrderName: true,
          printifyOrderId: true,
          error: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
      findReprintsOnHold().catch((err) => {
        console.error('Reprint on-hold lookup failed:', err);
        return [];
      }),
    ]);

    const items: AttentionItem[] = [];

    for (const t of manualThreads) {
      items.push({
        type: 'manual',
        id: `manual-${t.id}`,
        threadId: t.id,
        title: `${t.customerName || t.customerEmail}: ${t.subject}`,
        detail: t.manualReason,
        createdAt: (t.lastActionAt || t.updatedAt).toISOString(),
      });
    }

    // Skip failed drafts whose thread is already closed/trashed - not actionable.
    for (const d of failedDrafts) {
      if (!d.threadId) continue;
      if (d.thread?.status === 'CLOSED' || d.thread?.status === 'TRASHED') continue;
      items.push({
        type: 'draft_failed',
        id: `draft-${d.threadId}`,
        threadId: d.threadId,
        title: `AI draft failed: ${d.thread?.customerName || ''} ${d.thread?.subject || ''}`.trim(),
        detail: d.error,
        createdAt: d.updatedAt.toISOString(),
      });
    }

    for (const r of failedRelinks) {
      items.push({
        type: 'relink_failed',
        id: `relink-${r.id}`,
        threadId: null,
        title: `Printify relink failed${r.shopifyOrderName ? ` for ${r.shopifyOrderName}` : ''}`,
        detail: r.error || `Printify order ${r.printifyOrderId}`,
        createdAt: r.updatedAt.toISOString(),
      });
    }

    // Listed straight from the order cache, so an item goes away by itself
    // once the reprint is submitted.
    if (reprintsOnHold.length > 0) {
      const shopId = (await createPrintifyClient().catch(() => null))?.getShopId() || null;
      for (const r of reprintsOnHold) {
        items.push({
          type: 'reprint_on_hold',
          id: `reprint-${r.printifyOrderId}`,
          threadId: null,
          title: `Reprint for ${r.forOrderName || 'a customer order'} is not printing`,
          detail:
            `Made ${holdWords(r.hoursOnHold)} ago and still on hold${r.items.length ? ` (${r.items.join(', ')})` : ''}. ` +
            'It only prints once someone opens it in Printify and clicks Submit.',
          url: printifyOrderUrl(shopId, r.printifyOrderId),
          createdAt: r.createdAt,
        });
      }
    }

    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return NextResponse.json({ items, count: items.length });
  } catch (err) {
    console.error('Error fetching needs-attention:', err);
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

    const { threadId } = await request.json();
    if (!threadId) {
      return NextResponse.json({ error: 'threadId required' }, { status: 400 });
    }

    await prisma.thread.update({
      where: { id: threadId },
      data: { needsManual: false, manualResolvedAt: new Date() },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error resolving needs-attention:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
