/**
 * Late orders API
 * Orders not delivered within N days (default 13) of being ordered, from the
 * last 3 months.
 *
 * Printify is the only source with real delivery status: a shipment carries
 * delivered_at when the carrier confirms delivery (Shopify's fulfillment status
 * never sees that for these POD orders, and Printify does NOT set shipped_at).
 * Reads the LOCAL printify_orders cache - webhook-fed (every order:* event
 * refreshes its row) with an hourly windowed sweep + daily full walk as the
 * safety net - so this page costs zero Printify API calls and can't be stalled
 * by a rate limit. The computed result is still cached for 30 minutes;
 * ?fresh=1 forces a recompute.
 *
 * "Late" = no shipment has delivered_at AND the order was placed >= N days ago.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { PrintifyConfig, PrintifyOrder } from '@/lib/printify/types';
import { decryptJson } from '@/lib/encryption';
import { cacheGet, cacheSet, cacheKey, CACHE_TTL } from '@/lib/cache';
import { createShopifyClient } from '@/lib/shopify';
import { maybeReconcilePrintifyRecoveries } from '@/lib/printify/recovery';
import { pendingEscalationsWhere } from '@/lib/queues';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 90; // last 3 months
// Cache rows scanned per DB round-trip. The row payload is the full order
// JSON, so bounded chunks keep memory flat at ~10k+ in-window orders.
const SCAN_CHUNK = 1000;

interface LateOrder {
  printifyOrderId: string;
  externalId: string | null;
  orderName: string;
  // Printify's display order number (app_order_id, e.g. "19269685.17804") -
  // the reference Printify support recognizes in a message.
  printifyOrderNumber: string | null;
  daysSinceOrdered: number;
  daysSinceShipped: number | null;
  status: string;
  deliveryStatus: string;
  carrier: string | null;
  trackingUrl: string | null;
  printifyUrl: string;
  shopifyUrl: string | null; // link to the Shopify admin order
  // Set when a replacement has already been sent for this order.
  replacement: { via: string; label: string } | null;
  // Set when Shopify shows the order was (partially) refunded.
  refund: { label: string; amount: number } | null;
  // Shopify was checked and shows ZERO refunded - the customer-refunded
  // toggle can safely default to "No" (still operator-overridable).
  shopifyNoRefund?: boolean;
  // Customer refund tracking: manual yes/no (null = not decided). Combined with
  // the auto-detected `refund` and `replacement` above as the "made whole" signal.
  customerRefunded: boolean | null;
  // Whether Printify refunded us for this order (null = not decided yet).
  refundedByPrintify: boolean | null;
  // Auto-detected from a Printify support email, when present (drives the tick).
  // `note` is the matched sentence from the email - Printify's own words, incl.
  // the explanation when they declined a refund. `ticketUrl` links the ticket.
  printifyRecovery: {
    type: string;
    amountUsd: number | null;
    date: string;
    note: string | null;
    ticketUrl: string | null;
  } | null;
  // We asked Printify (refund/reprint/cancel) but no confirmation back yet.
  awaitingPrintify: { intent: string | null; since: string } | null;
  // Free-text notes - informational only, never resolves the order.
  note: string | null;
  // Customer contact (from the Printify recipient) so the tab can email them.
  customerEmail: string | null;
  customerName: string | null;
  // When the operator emailed the customer a delay update (ISO), else null.
  delayEmailedAt: string | null;
  // When the operator manually marked the order done/handled (ISO), else null.
  handledAt: string | null;
  // An OPEN Printify escalation (Needs Attention) exists for this order -
  // surfaced so the operator doesn't double-work it across the two pages.
  escalationOpen: boolean;
  // Latest support-inbox thread with this customer, for a direct linkout.
  threadId: string | null;
  // Derived: (customer made whole) AND (Printify decision recorded).
  resolved: boolean;
  fp: string | null; // internal: customer+address+SKU fingerprint
  shopOrderId: string | null; // internal: Shopify numeric order id for refund lookup
}

/**
 * Fingerprint a Printify order by who/where/what: customer name + zip + the
 * sorted set of SKUs. A Printify reprint is a separate (manual) order with the
 * SAME fingerprint as the original (same shirt, same customer, same address) -
 * which is the only link, since reprints carry no reference field in the API.
 */
function fingerprint(order: PrintifyOrder): string | null {
  const a = order.address_to || ({} as PrintifyOrder['address_to']);
  const name = `${a.first_name || ''} ${a.last_name || ''}`.trim().toLowerCase();
  const zip = (a.zip || '').replace(/\s/g, '').toLowerCase();
  const skus = (order.line_items || [])
    .map((li) => li.metadata?.sku || String(li.variant_id || ''))
    .filter(Boolean)
    .sort()
    .join(',');
  if (!name || !zip || !skus) return null;
  return `${name}|${zip}|${skus}`;
}

/**
 * The Printify DELIVERY status (where the package is), derived from the
 * line-item statuses - not the order lifecycle state. Printify reports delivery
 * on the line items: shipment_pre_transit / shipment_in_transit / shipment_delivered.
 */
function deliveryStatus(order: PrintifyOrder): string {
  const li = (order.line_items || []).map((l) => l.status || '');
  const has = (s: string) => li.includes(s);
  if (order.shipments?.some((s) => s.delivered_at) || has('shipment_delivered')) return 'Delivered';
  if (has('shipment_out_for_delivery')) return 'Out for delivery';
  if (has('shipment_in_transit')) return 'In transit';
  if (has('shipment_pre_transit')) return 'Label created';
  if (order.fulfilled_at || has('fulfilled') || has('shipping')) return 'Shipped';
  if (has('in-production') || order.sent_to_production_at) return 'In production';
  if (has('on-hold')) return 'On hold';
  return (order.status || 'unknown').replace(/[-_]/g, ' ');
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // On tab open, refresh Printify recoveries from the support inbox (throttled to
  // once per 12h, no-op without Gmail creds). Fire-and-forget so the tab loads
  // immediately; ticks show on the next load.
  void maybeReconcilePrintifyRecoveries();

  // "Late after" threshold in days. Default 13 (a normal made-to-order isn't
  // "late" yet); an explicit days=0 means "every undelivered order in the
  // 90-day window" (nothing filtered out by age).
  const daysParam = request.nextUrl.searchParams.get('days');
  const parsedDays = daysParam !== null ? parseInt(daysParam, 10) : 13;
  const thresholdDays = Number.isNaN(parsedDays) ? 13 : Math.max(0, parsedDays);
  const fresh = request.nextUrl.searchParams.get('fresh') === '1';
  // v2: rows carry printifyOrderNumber / escalationOpen / threadId.
  const listCacheKey = cacheKey.lateOrders(thresholdDays);

  if (!fresh) {
    const cached = await cacheGet<{ thresholdDays: number; count: number; orders: LateOrder[]; cachedAt: string }>(
      listCacheKey
    );
    if (cached) return NextResponse.json({ ...cached, cached: true });
  }

  const settings = await prisma.integrationSettings.findUnique({
    where: { type: 'PRINTIFY' },
  });
  if (!settings || !settings.enabled) {
    return NextResponse.json({ error: 'Printify is not connected' }, { status: 503 });
  }
  const config = decryptJson<PrintifyConfig>(settings.encryptedData);

  const now = Date.now();
  const windowStart = now - LOOKBACK_DAYS * DAY_MS;
  const late: LateOrder[] = [];
  // fingerprint -> the orders sharing it (to spot reprints: a manual order with
  // the same customer/address/SKU as a late one).
  const byFingerprint: Record<string, { id: string; orderType: string }[]> = {};

  // Scan the local cache in bounded chunks. The row's updatedAt is the order's
  // last activity (max of created/fulfilled/delivered), which is always >= its
  // created_at - so filtering updatedAt >= windowStart can't miss an in-window
  // order; older orders that merely had recent activity are dropped below on
  // their real created_at.
  let cursor: string | undefined;
  while (true) {
    const rows = await prisma.printifyOrderCache.findMany({
      where: {
        updatedAt: { gte: new Date(windowStart) },
        NOT: { status: { contains: 'cancel', mode: 'insensitive' } },
      },
      select: { id: true, data: true },
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: SCAN_CHUNK,
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      const order = row.data as unknown as PrintifyOrder;
      if (!order) continue;
      {
        const status = (order.status || '').toLowerCase();
        if (status.includes('cancel')) continue;

        const orderedAt = order.created_at ? new Date(order.created_at).getTime() : NaN;
        if (Number.isNaN(orderedAt)) continue;
        if (orderedAt < windowStart) continue;

        // Record the fingerprint of EVERY in-window order (incl. reprints and
        // delivered ones) so a late order can find its reprint sibling below.
        const fp = fingerprint(order);
        if (fp) {
          (byFingerprint[fp] ||= []).push({
            id: order.id,
            orderType: order.metadata?.order_type || '',
          });
        }

        const daysSinceOrdered = Math.floor((now - orderedAt) / DAY_MS);
        if (daysSinceOrdered < thresholdDays) continue;

        const shipments = order.shipments || [];
        if (shipments.some((s) => s.delivered_at)) continue; // delivered -> not late

        const fulfilledAt = order.fulfilled_at ? new Date(order.fulfilled_at).getTime() : NaN;
        const shipment = shipments[0];
        late.push({
          printifyOrderId: order.id,
          externalId: order.external_id || null,
          printifyOrderNumber: order.app_order_id || null,
          orderName:
            order.metadata?.shop_order_label ||
            order.label ||
            order.external_id ||
            order.id,
          daysSinceOrdered,
          daysSinceShipped: Number.isNaN(fulfilledAt)
            ? null
            : Math.floor((now - fulfilledAt) / DAY_MS),
          status: order.status,
          deliveryStatus: deliveryStatus(order),
          carrier: shipment?.carrier || null,
          trackingUrl: shipment?.url || null,
          printifyUrl: config.shopId
            ? `https://printify.com/app/store/${config.shopId}/order/${order.id}`
            : `https://printify.com/app/orders/${order.id}`,
          shopifyUrl: null,
          replacement: null,
          refund: null,
          customerRefunded: null,
          refundedByPrintify: null,
          printifyRecovery: null,
          awaitingPrintify: null,
          note: null,
          handledAt: null,
          customerEmail: order.address_to?.email || null,
          customerName:
            `${order.address_to?.first_name || ''} ${order.address_to?.last_name || ''}`.trim() ||
            null,
          delayEmailedAt: null,
          escalationOpen: false,
          threadId: null,
          resolved: false,
          fp,
          shopOrderId: order.metadata?.shop_order_id || null,
        });
      }
    }

    if (rows.length < SCAN_CHUNK) break;
  }

  // --- Replacement detection: has a replacement already been sent? ---
  // Reliable signals only:
  //  (1) A Shopify order tagged "Replacement" whose note references the original
  //      (e.g. "Replacement order for #20205 - lost"). Catches replacements
  //      created via the support desk.
  //  (2) OrderRelink (support-desk cancel/recreate relinks), matched by order name.
  // NOTE: Printify-direct reships create NO linkable record (no shared
  // external_id / shop_order_id, no Shopify order), so they cannot be detected.
  const digitsOf = (s: string | null | undefined) => (s || '').replace(/\D/g, '');

  if (late.length > 0) {
    const lateNames = late.map((l) => l.orderName);

    // (2) relinks, keyed by the original order-number digits + printify id
    const relinkByDigits = new Map<string, string>();
    const relinkByPid = new Map<string, string>();
    try {
      const relinks = await prisma.orderRelink.findMany({
        where: {
          OR: [
            { originalPrintifyOrderId: { in: late.map((l) => l.printifyOrderId) } },
            { shopifyOrderName: { in: lateNames } },
          ],
        },
      });
      for (const r of relinks) {
        const label = r.shopifyOrderName ? `Replacement ${r.shopifyOrderName}` : 'Replacement created';
        if (r.shopifyOrderName) relinkByDigits.set(digitsOf(r.shopifyOrderName), label);
        if (r.originalPrintifyOrderId) relinkByPid.set(r.originalPrintifyOrderId, label);
      }
    } catch (err) {
      console.warn('[late-orders] relink lookup failed', err);
    }

    // (1) Shopify Replacement orders -> the order-number digits they reference
    const replacedDigits = new Set<string>();
    try {
      const shopify = await createShopifyClient();
      if (shopify) {
        const repls = await shopify.getReplacementOrders(new Date(windowStart).toISOString());
        for (const r of repls) {
          const m = (r.note || '').match(/for\s+#?(\d{3,})/i);
          if (m) replacedDigits.add(m[1]);
        }
      }
    } catch (err) {
      console.warn('[late-orders] replacement-order lookup failed', err);
    }

    for (const l of late) {
      const d = digitsOf(l.orderName);
      const relink = relinkByPid.get(l.printifyOrderId) || relinkByDigits.get(d);
      // A Printify reprint: a separate MANUAL order with the same fingerprint
      // (same customer, address, and shirt) as this late order.
      const reprint =
        l.fp &&
        (byFingerprint[l.fp] || []).some(
          (o) => o.id !== l.printifyOrderId && o.orderType === 'manual'
        );
      if (relink) {
        l.replacement = { via: 'relink', label: relink };
      } else if (d && replacedDigits.has(d)) {
        l.replacement = { via: 'shopify-replacement', label: 'Replacement sent' };
      } else if (reprint) {
        l.replacement = { via: 'printify-reprint', label: 'Reprint sent' };
      }
    }

    // --- Refund status: match to Shopify and flag orders already refunded ---
    try {
      const shopify = await createShopifyClient();
      const shopIds = late.map((l) => l.shopOrderId).filter(Boolean) as string[];
      if (shopify) {
        // Link each order number to its Shopify admin order.
        const domain = shopify.getStoreDomain();
        if (domain) {
          for (const l of late) {
            if (l.shopOrderId) l.shopifyUrl = `https://${domain}/admin/orders/${l.shopOrderId}`;
          }
        }
      }
      if (shopify && shopIds.length > 0) {
        const refundMap = await shopify.getOrdersRefundStatus(shopIds);
        for (const l of late) {
          const r = l.shopOrderId ? refundMap[l.shopOrderId] : undefined;
          if (!r) continue;
          const fs = (r.financialStatus || '').toUpperCase();
          if (fs === 'REFUNDED' || (fs === 'PARTIALLY_REFUNDED' && r.totalRefunded > 0) || r.totalRefunded > 0) {
            l.refund = {
              label: fs === 'REFUNDED' ? 'Refunded' : 'Partial refund',
              amount: r.totalRefunded,
            };
          } else {
            // Shopify answered and shows $0 refunded - surface that as an
            // auto "No" default instead of an unanswered toggle.
            l.shopifyNoRefund = true;
          }
        }
      }
    } catch (err) {
      console.warn('[late-orders] refund lookup failed', err);
    }

    // --- Operator manual resolutions (customer refund / Printify refund / note) ---
    try {
      const resolutions = await prisma.lateOrderResolution.findMany({
        where: { printifyOrderId: { in: late.map((l) => l.printifyOrderId) } },
      });
      const byId = new Map(resolutions.map((r) => [r.printifyOrderId, r]));
      for (const l of late) {
        const r = byId.get(l.printifyOrderId);
        if (r) {
          l.customerRefunded = r.customerRefunded;
          l.refundedByPrintify = r.refundedByPrintify;
          l.note = r.note || null;
          l.delayEmailedAt = r.delayEmailedAt ? r.delayEmailedAt.toISOString() : null;
          l.handledAt = r.handledAt ? r.handledAt.toISOString() : null;
          // "Awaiting Printify": asked but no decision recorded yet.
          if (r.printifyRequestedAt && r.refundedByPrintify == null) {
            l.awaitingPrintify = {
              intent: r.printifyRequestIntent,
              since: r.printifyRequestedAt.toISOString(),
            };
          }
        }
      }

      // Auto-detected Printify outcomes (from support emails): show the amount /
      // type behind the "Refunded by Printify" tick. Newest per order wins.
      const recoveries = await prisma.printifyRecovery.findMany({
        where: { printifyOrderId: { in: late.map((l) => l.printifyOrderId) } },
        orderBy: { emailDate: 'desc' },
      });
      const recById = new Map<string, (typeof recoveries)[number]>();
      // Orders Printify reprinted (from the support email) - a reprint IS the
      // replacement, so it makes the customer whole for resolution below.
      const reprintedIds = new Set<string>();
      for (const rec of recoveries) {
        if (!rec.printifyOrderId) continue;
        if (!recById.has(rec.printifyOrderId)) recById.set(rec.printifyOrderId, rec);
        if (rec.type === 'reprint') reprintedIds.add(rec.printifyOrderId);
      }
      for (const l of late) {
        const rec = recById.get(l.printifyOrderId);
        if (rec) {
          l.printifyRecovery = {
            type: rec.type,
            amountUsd: rec.amountUsd,
            date: rec.emailDate.toISOString(),
            // Printify's own sentence from the email (their explanation),
            // bounded so the payload stays small.
            note: rec.evidence ? rec.evidence.slice(0, 500) : null,
            ticketUrl: rec.ticketUrl,
          };
        }
        if (reprintedIds.has(l.printifyOrderId) && !l.replacement) {
          l.replacement = { via: 'printify-recovery', label: 'Reprint (Printify)' };
        }
      }
    } catch (err) {
      console.warn('[late-orders] resolution lookup failed', err);
    }

    // --- Open Printify escalations (Needs Attention overlap) ---
    // One grouped query: is there a PENDING escalation for any of these
    // Printify orders? Surfaced as a badge so the operator sees the overlap
    // instead of double-working the order on both pages.
    try {
      const openEscalations = await prisma.printifyEscalation.findMany({
        where: {
          ...pendingEscalationsWhere(),
          printifyOrderId: { in: late.map((l) => l.printifyOrderId) },
        },
        select: { printifyOrderId: true },
      });
      const escalatedIds = new Set(
        openEscalations.map((e) => e.printifyOrderId).filter(Boolean) as string[]
      );
      for (const l of late) {
        if (escalatedIds.has(l.printifyOrderId)) l.escalationOpen = true;
      }
    } catch (err) {
      console.warn('[late-orders] escalation lookup failed', err);
    }

    // --- Latest inbox thread per customer, for a direct Thread linkout ---
    try {
      const emails = [
        ...new Set(
          late.map((l) => (l.customerEmail || '').toLowerCase()).filter(Boolean)
        ),
      ];
      if (emails.length > 0) {
        const threads = await prisma.thread.findMany({
          where: { customerEmail: { in: emails, mode: 'insensitive' } },
          orderBy: { lastMessageAt: 'desc' },
          select: { id: true, customerEmail: true },
        });
        const latestByEmail = new Map<string, string>();
        for (const t of threads) {
          const key = t.customerEmail.toLowerCase();
          if (!latestByEmail.has(key)) latestByEmail.set(key, t.id);
        }
        for (const l of late) {
          if (l.customerEmail) {
            l.threadId = latestByEmail.get(l.customerEmail.toLowerCase()) || null;
          }
        }
      }
    } catch (err) {
      console.warn('[late-orders] thread lookup failed', err);
    }
  }

  // Derived resolution: an order is resolved when the customer has been made
  // whole (auto-detected refund or replacement, OR the manual customer-refund
  // flag) AND a Printify-refund decision has been recorded (yes or no) - OR
  // when the operator explicitly marked it done (only allowed once both refund
  // questions are answered). Notes alone never resolve an order.
  for (const l of late) {
    const customerWhole =
      !!l.replacement || !!l.refund || l.customerRefunded === true;
    const printifyDecided =
      l.refundedByPrintify === true || l.refundedByPrintify === false;
    l.resolved = (customerWhole && printifyDecided) || l.handledAt != null;
  }

  late.sort((a, b) => b.daysSinceOrdered - a.daysSinceOrdered);

  const payload = {
    thresholdDays,
    count: late.length,
    // Drop internal fields (fingerprint has customer data; shopOrderId is internal).
    orders: late.map(({ fp: _fp, shopOrderId: _sid, ...rest }) => rest),
    cachedAt: new Date(now).toISOString(),
  };
  await cacheSet(listCacheKey, payload, CACHE_TTL.LONG); // 30 min
  return NextResponse.json({ ...payload, cached: false });
}
