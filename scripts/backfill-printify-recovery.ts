/**
 * One-off backfill: apply Printify recovery detection to emails collected out of
 * band (Gmail MCP) instead of via IMAP, for the window before the worker's
 * GMAIL_IMAP_* creds are configured. Reads /tmp/printify_backfill/emails.json
 * ([{messageId,date,ticketUrl,text}]), parses outcomes, cross-references the Late
 * Deliveries set, and (with --commit) records recoveries + ticks the tracker.
 *
 * Dry run:  DATABASE_URL=... npx tsx scripts/backfill-printify-recovery.ts
 * Apply:    DATABASE_URL=... npx tsx scripts/backfill-printify-recovery.ts --commit
 */

import { readFileSync } from 'fs';
import prisma from '@/lib/db';
import { parsePrintifyEmail } from '@/lib/printify/email-parser';

const COMMIT = process.argv.includes('--commit');
const RESOLVED_BY = 'Printify (auto)';
const FILE = '/tmp/printify_backfill/emails.json';

interface InEmail {
  messageId: string;
  date: string;
  ticketUrl?: string;
  text: string;
}

async function main() {
  const emails: InEmail[] = JSON.parse(readFileSync(FILE, 'utf8'));
  console.log(`Loaded ${emails.length} emails. Mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}\n`);

  // app_order_id -> { hex id, status, delivered, daysSinceCreated }
  const cache = await prisma.printifyOrderCache.findMany({
    select: { id: true, data: true, status: true },
  });
  const map = new Map<
    string,
    { hex: string; status: string; delivered: boolean; days: number }
  >();
  for (const row of cache) {
    const d = row.data as {
      app_order_id?: string;
      created_at?: string;
      shipments?: { delivered_at?: string }[];
    } | null;
    if (!d?.app_order_id) continue;
    const delivered = (d.shipments || []).some((s) => s.delivered_at);
    const days = d.created_at
      ? Math.floor((Date.now() - new Date(d.created_at).getTime()) / 86400000)
      : -1;
    map.set(d.app_order_id, { hex: row.id, status: row.status, delivered, days });
  }
  console.log(`Order cache: ${map.size} orders with an app_order_id\n`);

  let created = 0;
  let ticked = 0;
  let escClosed = 0;
  let amount = 0;
  let awaiting = 0;
  const resolvedIds = new Set<string>();
  const requestRows = new Map<string, { intent: string; date: string }>();

  for (const email of emails) {
    const { resolutions, requests } = parsePrintifyEmail(email.text);
    for (const r of requests) {
      const prev = requestRows.get(r.appOrderId);
      if (!prev || email.date < prev.date) {
        requestRows.set(r.appOrderId, { intent: r.intent, date: email.date });
      }
    }

    for (const res of resolutions) {
      resolvedIds.add(res.appOrderId);
      const hit = map.get(res.appOrderId);
      const loc = hit
        ? `${hit.hex.slice(0, 8)}… status=${hit.status} delivered=${hit.delivered} ${hit.days}d`
        : 'NOT in order cache';
      const amt = res.amountUsd != null ? ` $${res.amountUsd.toFixed(2)}` : '';
      console.log(
        `RESOLUTION ${res.appOrderId} -> ${res.type}${amt}  [${loc}]`
      );

      if (!COMMIT) {
        if (res.amountUsd) amount += res.amountUsd;
        continue;
      }

      // Dedup at the order+type level so the IMAP worker won't double-count later.
      const dupe = await prisma.printifyRecovery.findFirst({
        where: { appOrderId: res.appOrderId, type: res.type },
      });
      if (!dupe) {
        await prisma.printifyRecovery.create({
          data: {
            appOrderId: res.appOrderId,
            printifyOrderId: hit?.hex ?? null,
            type: res.type,
            amountUsd: res.amountUsd ?? null,
            reprintAppOrderId: res.reprintAppOrderId ?? null,
            emailMessageId: email.messageId,
            emailDate: new Date(email.date),
            ticketUrl: email.ticketUrl ?? null,
            evidence: res.evidence.slice(0, 2000),
            matched: Boolean(hit?.hex),
          },
        });
        created++;
        if (res.amountUsd) amount += res.amountUsd;
      }

      if (hit?.hex) {
        const t = await prisma.lateOrderResolution.findUnique({
          where: { printifyOrderId: hit.hex },
          select: { refundedByPrintify: true },
        });
        if (t?.refundedByPrintify !== true) {
          await prisma.lateOrderResolution.upsert({
            where: { printifyOrderId: hit.hex },
            create: {
              printifyOrderId: hit.hex,
              refundedByPrintify: true,
              resolvedBy: RESOLVED_BY,
            },
            update: { refundedByPrintify: true, resolvedBy: RESOLVED_BY },
          });
          ticked++;
        }
        const c = await prisma.printifyEscalation.updateMany({
          where: { printifyOrderId: hit.hex, printifyHandled: false },
          data: {
            printifyHandled: true,
            printifyHandledAt: new Date(email.date),
            printifyHandledBy: RESOLVED_BY,
          },
        });
        escClosed += c.count;
      }
    }
  }

  console.log('\n--- Awaiting-Printify requests (no confirmation email yet) ---');
  for (const [id, req] of [...requestRows.entries()].sort()) {
    if (resolvedIds.has(id)) continue; // answered in this batch
    const hit = map.get(id);
    const loc = hit
      ? `${hit.hex.slice(0, 8)}… status=${hit.status} delivered=${hit.delivered} ${hit.days}d`
      : 'NOT in order cache';
    console.log(`  ${id} (${req.intent})  [${loc}]`);

    if (COMMIT && hit?.hex) {
      const existing = await prisma.lateOrderResolution.findUnique({
        where: { printifyOrderId: hit.hex },
        select: { refundedByPrintify: true, printifyRequestedAt: true },
      });
      const recovered = await prisma.printifyRecovery.findFirst({
        where: { printifyOrderId: hit.hex },
        select: { id: true },
      });
      if (
        !recovered &&
        existing?.refundedByPrintify == null &&
        !existing?.printifyRequestedAt
      ) {
        await prisma.lateOrderResolution.upsert({
          where: { printifyOrderId: hit.hex },
          create: {
            printifyOrderId: hit.hex,
            printifyRequestedAt: new Date(req.date),
            printifyRequestIntent: req.intent,
          },
          update: {
            printifyRequestedAt: new Date(req.date),
            printifyRequestIntent: req.intent,
          },
        });
        awaiting++;
      }
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(
    `recoveries created=${created} tracker ticked=${ticked} escalations closed=${escClosed} cash refunds=$${amount.toFixed(2)}`
  );
  console.log(`awaiting-Printify flagged=${awaiting}`);
  if (!COMMIT) console.log('\n(DRY RUN - nothing written. Re-run with --commit to apply.)');

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
