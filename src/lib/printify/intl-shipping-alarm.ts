/**
 * International shipping alarm.
 *
 * Printify decides which print provider fulfils an order AFTER the sale, from
 * whatever the regional providers have in stock that hour. When the local one
 * is out of the ordered color/size, it silently routes the line to a US
 * provider and bills transatlantic shipping - $18.49 on a single sweatshirt to
 * Germany (#32782), $12.49 on a Grey/3XL Premium tee to Australia (#35508).
 * Nothing in Printify tells you; the money shows up on the invoice weeks later.
 *
 * A 180-day audit (2026-08-31) found 6 such orders costing ~$66. Every one was
 * a color/size the destination's provider could not make that day, so blocking
 * colors in the theme cannot prevent it - two of the offending combos were on
 * the approved international list. Detection is the only reliable lever.
 *
 * This raises the alarm while the order is still cancelable: Printify does not
 * auto-send to production until ~11pm PT, so an hourly check leaves hours of
 * room to cancel, reorder in a stocked color, or accept the cost knowingly.
 */

import prisma from "@/lib/db";
import { createOutboundEmailSender } from "@/lib/email";
import { createPrintifyClient, PrintifyClient } from "./index";
import { createShopifyClient, ShopifyClient } from "@/lib/shopify";
import { PrintifyOrder, PrintifyLineItem } from "./types";

/** Line items carry the production country in metadata, which the shared type
 *  does not model, and the orders endpoint returns `shipping_cost` where the
 *  type says `shipping`. Both are read defensively rather than widening the
 *  shared type, which other call sites rely on. */
type LineItemWithRouting = PrintifyLineItem & {
  shipping_cost?: number;
  metadata?: PrintifyLineItem["metadata"] & { country?: string };
};

const ACTION = "intl_shipping_alert";

/** Dollars of overspend that make an order worth waking Pati for. Below this
 *  the gap is ordinary per-item shipping stacking on a multi-item order.
 *
 *  Lowered from 5 to 3 on 2026-09-04. Printify's quoted international rates now
 *  sit at the US-routed level even for destinations with a local provider: the
 *  same Premium tee that billed $4.89 printed in Australia on 2026-08-27 quotes
 *  $12.99 to Sydney today. Against the AUD 9.87/11.87 the store collects (~$8.52)
 *  that is a $4.47 gap - real money, but it slipped under a $5 floor, and if the
 *  line prints locally the misrouting branch does not catch it either. */
const DEFAULT_THRESHOLD_USD = 3;

/** How far back to look. Comfortably wider than the hourly cadence so a worker
 *  restart or a Printify webhook hiccup cannot let an order slip through. */
const DEFAULT_LOOKBACK_HOURS = 48;

/** Printify pages to walk at most (50 orders each). At ~200 orders/day this
 *  covers the lookback several times over; the cap stops a runaway scan. */
const MAX_PAGES = 20;

/**
 * Which print-provider countries count as "local" for a destination, i.e. do
 * not incur an international shipping bill. Printify's regional providers are
 * in AU, CA, CZ, DE, ES, FR, GB, LV and the US; anything shipping to an EU
 * address from another EU country is intra-EU and cheap.
 */
const EU = new Set([
  "Austria",
  "Belgium",
  "Bulgaria",
  "Croatia",
  "Cyprus",
  "Czech Republic",
  "Czechia",
  "Denmark",
  "Estonia",
  "Finland",
  "France",
  "Germany",
  "Greece",
  "Hungary",
  "Ireland",
  "Italy",
  "Latvia",
  "Lithuania",
  "Luxembourg",
  "Malta",
  "Netherlands",
  "Poland",
  "Portugal",
  "Romania",
  "Slovakia",
  "Slovenia",
  "Spain",
  "Sweden",
]);

function isLocalRouting(shipTo: string, printedIn: string): boolean {
  if (shipTo === printedIn) return true;
  if (EU.has(shipTo) && EU.has(printedIn)) return true;
  // Australia serves New Zealand; there is no NZ provider.
  if (shipTo === "New Zealand" && printedIn === "Australia") return true;
  return false;
}

/**
 * What the storefront collects for this destination, in USD, as a fallback for
 * when the Shopify order cannot be read back (older orders drop out of the
 * search window). Taken from the live delivery profile on 2026-08-31 and
 * converted at that day's rates - a floor for comparison, not accounting.
 */
const FALLBACK_COLLECTED_USD: Record<string, number> = {
  "United Kingdom": 3.3,
  Germany: 3.3,
  France: 4.6,
  Ireland: 7.1,
  Canada: 6.9,
  Australia: 6.5,
  "New Zealand": 10.2,
  Japan: 9.4,
};
const FALLBACK_EU_USD = 4.9;

function collectedFallback(country: string): number {
  return (
    FALLBACK_COLLECTED_USD[country] ?? (EU.has(country) ? FALLBACK_EU_USD : 0)
  );
}

export interface IntlShippingFinding {
  printifyOrderId: string;
  /** Shopify order name, e.g. "#36739". Reorders placed by hand through the
   *  API carry no store number, so this falls back to the Printify id and
   *  `hasStoreNumber` says which it is. */
  orderName: string;
  hasStoreNumber: boolean;
  country: string;
  status: string;
  createdAt: string;
  shippingChargedUsd: number;
  shippingCollectedUsd: number;
  /** Positive means the order lost money on shipping. */
  gapUsd: number;
  /** Whether the collected figure came from Shopify or the fallback table. */
  collectedSource: "shopify" | "estimate";
  /** Lines that printed outside the destination's region - the usual cause. */
  misroutedLines: {
    title: string;
    variant: string;
    printedIn: string;
    shippingUsd: number;
  }[];
}

export interface IntlShippingAlarmResult {
  scanned: number;
  international: number;
  findings: IntlShippingFinding[];
  alerted: number;
  emailSent: boolean;
}

function cents(n: number | undefined | null): number {
  return typeof n === "number" ? n / 100 : 0;
}

/** Live lines only: Printify Choice cancels its initial US placement when it
 *  re-routes regionally, and that dead line still carries the US country. */
function liveLines(order: PrintifyOrder): LineItemWithRouting[] {
  return (order.line_items || []).filter(
    (li) => li.status !== "canceled",
  ) as LineItemWithRouting[];
}

/** Inspect one order. Returns null when nothing is wrong with it. */
export function evaluateOrder(
  order: PrintifyOrder,
  collectedUsd: number,
  collectedSource: "shopify" | "estimate",
  thresholdUsd: number,
): IntlShippingFinding | null {
  const country = order.address_to?.country || "";
  const charged = cents(order.total_shipping);
  const gap = charged - collectedUsd;

  const misrouted = liveLines(order)
    .filter((li) => {
      const printedIn = li.metadata?.country;
      return !!printedIn && !isLocalRouting(country, printedIn);
    })
    .map((li) => ({
      title: li.metadata?.title || "unknown item",
      variant: li.metadata?.variant_label || "",
      printedIn: li.metadata?.country || "unknown",
      shippingUsd: cents(li.shipping_cost ?? li.shipping),
    }));

  // Worth reporting when it actually costs money, or when a line printed in
  // the wrong region - misrouting is the leading indicator and shows up before
  // the full shipping charge settles on a partially-routed order.
  if (gap < thresholdUsd && misrouted.length === 0) return null;

  const storeNumber = order.metadata?.shop_order_label || order.label || null;

  return {
    printifyOrderId: order.id,
    orderName: storeNumber || order.id,
    hasStoreNumber: !!storeNumber,
    country,
    status: order.status,
    createdAt: order.created_at,
    shippingChargedUsd: Number(charged.toFixed(2)),
    shippingCollectedUsd: Number(collectedUsd.toFixed(2)),
    gapUsd: Number(gap.toFixed(2)),
    collectedSource,
    misroutedLines: misrouted,
  };
}

function esc(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Deep link to one order in the Printify app. The store-scoped path is the one
 * that actually opens the order; `/app/orders/<id>` silently lands on the
 * dashboard instead, so the shop id is not optional in practice.
 */
function printifyOrderUrl(orderId: string, shopId: string | null): string {
  return shopId
    ? `https://printify.com/app/store/${shopId}/order/${orderId}`
    : `https://printify.com/app/orders/${orderId}`;
}

function buildEmail(findings: IntlShippingFinding[], shopId: string | null): string {
  let html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#222">` +
    `<p>Printify is charging more to ship these international orders than the store collected.</p>`;

  for (const f of findings) {
    const cancelable = f.status !== "fulfilled" && f.status !== "canceled";
    html +=
      `<div style="margin:16px 0;padding:12px;border-left:3px solid #b00;background:#fafafa">` +
      `<div style="font-weight:600">${esc(f.hasStoreNumber ? f.orderName : 'Manual reorder (no store number)')} - ${esc(f.country)}` +
      `${cancelable ? ' <span style="color:#b00">(still cancelable)</span>' : ""}</div>` +
      `<div>Printify shipping <b>$${f.shippingChargedUsd.toFixed(2)}</b>, ` +
      `collected $${f.shippingCollectedUsd.toFixed(2)}` +
      `${f.collectedSource === "estimate" ? " (estimated)" : ""} - ` +
      `<b>out of pocket $${f.gapUsd.toFixed(2)}</b></div>`;

    if (f.misroutedLines.length > 0) {
      html += `<div style="margin-top:6px">Printed outside ${esc(f.country)}:</div><ul style="margin:4px 0">`;
      for (const l of f.misroutedLines) {
        html +=
          `<li>${esc(l.title)}${l.variant ? ` (${esc(l.variant)})` : ""} - ` +
          `made in ${esc(l.printedIn)}, $${l.shippingUsd.toFixed(2)} shipping</li>`;
      }
      html += `</ul><div style="color:#555;font-size:12px">Usually the local printer was out of that color or size.</div>`;
    }

    html +=
      `<div style="margin-top:8px"><a href="${esc(printifyOrderUrl(f.printifyOrderId, shopId))}">Open in Printify</a></div>` +
      `</div>`;
  }

  html +=
    `<p style="color:#555;font-size:12px">Printify does not send anything to production until about 11pm PT, ` +
    `so an order still marked on-hold or in-production can usually still be canceled.</p></div>`;
  return html;
}

/**
 * Scan recent international orders and report the ones bleeding shipping.
 *
 * Each order is alerted once, ever - the ActionLog row is the dedupe key, so a
 * restart or an overlapping run cannot re-send. `dryRun` skips both the log
 * write and the email, for checking what it would have caught.
 */
export async function runIntlShippingAlarm(opts?: {
  lookbackHours?: number;
  thresholdUsd?: number;
  dryRun?: boolean;
  /** Injected clients, for the dry-run script to drive live data without the
   *  credential store. Production passes neither. */
  printifyClient?: PrintifyClient;
  shopifyClient?: ShopifyClient | null;
}): Promise<IntlShippingAlarmResult> {
  const lookbackHours = opts?.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
  const thresholdUsd = opts?.thresholdUsd ?? DEFAULT_THRESHOLD_USD;
  const dryRun = opts?.dryRun ?? false;

  const result: IntlShippingAlarmResult = {
    scanned: 0,
    international: 0,
    findings: [],
    alerted: 0,
    emailSent: false,
  };

  const printify = opts?.printifyClient ?? (await createPrintifyClient());
  if (!printify) {
    console.error("[intl-shipping-alarm] Printify is not configured");
    return result;
  }

  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
  const candidates: PrintifyOrder[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const orders = await printify.listOrders(page, 50);
    if (orders.length === 0) break;

    let reachedCutoff = false;
    for (const order of orders) {
      result.scanned++;
      const created = Date.parse((order.created_at || "").replace(" ", "T"));
      if (Number.isFinite(created) && created < cutoff) {
        reachedCutoff = true;
        continue;
      }
      const country = order.address_to?.country;
      if (!country || country === "United States") continue;
      // A canceled order costs nothing; a fulfilled one is already paid for,
      // but still worth reporting so the pattern is visible.
      if (order.status === "canceled") continue;
      result.international++;
      candidates.push(order);
    }
    if (reachedCutoff) break;
    if (page === MAX_PAGES) {
      console.warn(
        `[intl-shipping-alarm] hit the ${MAX_PAGES}-page cap before reaching the ` +
          `${lookbackHours}h cutoff - older orders in the window were not checked`
      );
    }
  }

  if (candidates.length === 0) return result;

  // Skip anything already reported before spending Shopify calls on it. A dry
  // run reports everything in the window, so it does not need the log at all.
  const alreadyAlerted = dryRun
    ? new Set<string>()
    : new Set(
        (
          await prisma.actionLog.findMany({
            where: {
              action: ACTION,
              orderName: {
                in: candidates.map((o) => o.metadata?.shop_order_label || o.id),
              },
            },
            select: { orderName: true },
          })
        ).map((r) => r.orderName as string),
      );

  const shopify =
    opts?.shopifyClient !== undefined
      ? opts.shopifyClient
      : await createShopifyClient();

  for (const order of candidates) {
    const orderName =
      order.metadata?.shop_order_label || order.label || order.id;
    if (alreadyAlerted.has(orderName)) continue;

    const country = order.address_to?.country || "";
    let collected = collectedFallback(country);
    let source: "shopify" | "estimate" = "estimate";

    // The real figure beats the table: it already carries the exact rate tier
    // the customer picked and the day's exchange rate.
    if (shopify && orderName.startsWith("#")) {
      try {
        const shopifyOrder = await shopify.getOrderByNumber(orderName);
        const paid = parseFloat(shopifyOrder?.totalShippingPrice ?? "");
        if (Number.isFinite(paid)) {
          collected = paid;
          source = "shopify";
        }
      } catch (err) {
        console.error(
          `[intl-shipping-alarm] Shopify lookup failed for ${orderName}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    const finding = evaluateOrder(order, collected, source, thresholdUsd);
    if (finding) result.findings.push(finding);
  }

  if (result.findings.length === 0) return result;

  // Worst first - if only one gets acted on, it should be the expensive one.
  result.findings.sort((a, b) => b.gapUsd - a.gapUsd);

  if (dryRun) return result;

  const to = process.env.ESCALATION_DIGEST_TO || "summitsoulbrand@gmail.com";
  try {
    const sender = await createOutboundEmailSender();
    if (sender) {
      const total = result.findings.reduce(
        (sum, f) => sum + Math.max(f.gapUsd, 0),
        0,
      );
      await sender.sendMessage({
        to: [{ address: to }],
        fromName: "Summit Soul Desk",
        subject:
          `Printify overshipping ${result.findings.length} international ` +
          `order${result.findings.length === 1 ? "" : "s"} ($${total.toFixed(2)} out of pocket)`,
        bodyHtml: buildEmail(result.findings, printify.getShopId() || null),
      });
      result.emailSent = true;
    }
  } catch (err) {
    console.error(
      "[intl-shipping-alarm] email failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // Only mark as alerted once the email is actually out, so a send failure
  // retries on the next tick instead of swallowing the order silently.
  if (result.emailSent) {
    for (const f of result.findings) {
      await prisma.actionLog.create({
        data: {
          userName: "system",
          action: ACTION,
          orderName: f.orderName,
          amountCents: Math.round(f.gapUsd * 100),
          summary:
            `Printify shipping $${f.shippingChargedUsd.toFixed(2)} vs $${f.shippingCollectedUsd.toFixed(2)} ` +
            `collected on ${f.orderName} (${f.country})`,
          metadata: JSON.parse(JSON.stringify(f)),
        },
      });
      result.alerted++;
    }
  }

  return result;
}
