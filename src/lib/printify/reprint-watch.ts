/**
 * Reprints left on hold in Printify.
 *
 * A reprint only prints once someone submits it, and a missed click is
 * invisible: #38075's sat on hold from 09-18 to 09-24 while the customer was
 * told twice it was being made. So a reprint still on hold after
 * REPRINT_HOLD_HOURS shows in Needs Attention until it goes to print (worked
 * out live from the order cache, so it clears itself), and is posted once to
 * #escalations when first seen (claimed in issue_alerts, so a restart or a
 * second worker never posts it twice). Pati 2026-09-24: both.
 */

import prisma from '@/lib/db';
import { createPrintifyClient } from '@/lib/printify';
import { postToSlack } from '@/lib/slack';
import {
  heldTooLong,
  printifyOrderUrl,
  reprintOnHoldMessage,
  reprintParentId,
  shopifyNameFromLabel,
  type ReprintOnHold,
} from './reprint';
import type { PrintifyOrder } from './types';

export { holdWords, printifyOrderUrl, type ReprintOnHold } from './reprint';

export async function findReprintsOnHold(now: Date = new Date()): Promise<ReprintOnHold[]> {
  // On-hold is a short list (the day's new orders plus anything stuck), and
  // status is indexed, so this never reads the whole cache.
  const rows = await prisma.printifyOrderCache.findMany({
    where: {
      status: { in: ['on-hold', 'on_hold'] },
      data: { path: ['metadata', 'is_reprint'], equals: true },
    },
    select: { id: true, data: true },
    take: 100,
  });
  const held = rows
    .map((r) => ({ id: r.id, order: r.data as unknown as PrintifyOrder }))
    .filter(({ order }) => heldTooLong(order, now));
  if (held.length === 0) return [];

  // Which order each one replaces: the relink row when it was linked, else
  // the label on the order it reprints.
  const [relinks, parents] = await Promise.all([
    prisma.orderRelink.findMany({
      where: { printifyOrderId: { in: held.map((h) => h.id) } },
      select: { printifyOrderId: true, shopifyOrderName: true },
    }),
    prisma.printifyOrderCache.findMany({
      where: {
        id: { in: held.map((h) => reprintParentId(h.order)).filter((x): x is string => !!x) },
      },
      select: { id: true, metadataShopOrderLabel: true },
    }),
  ]);
  const nameByReprint = new Map(relinks.map((r) => [r.printifyOrderId, r.shopifyOrderName]));
  const labelByParent = new Map(parents.map((p) => [p.id, p.metadataShopOrderLabel]));

  return held.map(({ id, order }) => {
    const created = new Date(String(order.created_at).replace(' ', 'T'));
    const parentId = reprintParentId(order);
    return {
      printifyOrderId: id,
      appOrderId: order.app_order_id || null,
      forOrderName:
        nameByReprint.get(id) ||
        shopifyNameFromLabel(parentId ? labelByParent.get(parentId) : null),
      createdAt: created.toISOString(),
      hoursOnHold: Math.floor((now.getTime() - created.getTime()) / (60 * 60 * 1000)),
      items: order.line_items.map((li) =>
        [li.metadata?.title, li.metadata?.variant_label].filter(Boolean).join(' - ')
      ),
    };
  });
}

/**
 * Post each newly stuck reprint to #escalations, once. Returns how many were
 * posted. A failed post gives the claim back so the next pass tries again.
 */
export async function alertReprintsOnHold(now: Date = new Date()): Promise<number> {
  const held = await findReprintsOnHold(now);
  if (held.length === 0) return 0;

  const client = await createPrintifyClient();
  const shopId = client?.getShopId() || null;

  let posted = 0;
  for (const r of held) {
    const key = `reprint-hold:${r.printifyOrderId}`;
    const claim = await prisma.issueAlert.createMany({
      data: [
        {
          key,
          kind: 'REPRINT_ON_HOLD',
          label: `Reprint for ${r.forOrderName || r.appOrderId || r.printifyOrderId} on hold`,
        },
      ],
      skipDuplicates: true,
    });
    if (claim.count === 0) continue; // already posted

    const delivered = await postToSlack(
      reprintOnHoldMessage(r, printifyOrderUrl(shopId, r.printifyOrderId))
    );
    if (!delivered) {
      await prisma.issueAlert.deleteMany({ where: { key } });
      console.error(
        `[reprint-watch] Slack did not take the alert for reprint ${r.appOrderId || r.printifyOrderId} - will retry`
      );
      continue;
    }
    posted++;
    console.log(
      `[reprint-watch] Reprint ${r.appOrderId || r.printifyOrderId} for ${r.forOrderName || '?'} on hold ${r.hoursOnHold}h - posted to #escalations`
    );
  }
  return posted;
}
