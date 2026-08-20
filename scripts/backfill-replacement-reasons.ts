/**
 * Backfill the canonical reason tag onto past replacement orders.
 *
 * Two sources, in order of trust:
 *   1. A reason already on the order in an older spelling ('Too large',
 *      'print', 'lost') - folded to its canonical tag.
 *   2. The customer's own words in the support desk thread, for orders that
 *      carry no reason at all.
 *
 * Additive only. It uses tagsAdd, never orderUpdate, so existing tags are
 * untouched - an orderUpdate with a partial tag list would silently wipe the
 * rest. Nothing is ever removed.
 *
 *   npx tsx scripts/backfill-replacement-reasons.ts            # dry run
 *   npx tsx scripts/backfill-replacement-reasons.ts --apply    # writes
 *   npx tsx scripts/backfill-replacement-reasons.ts --since 2026-01-01
 */

import prisma from '../src/lib/db';
import { createShopifyClient } from '../src/lib/shopify';
import {
  detectReplacementReason,
  customerWordsOnly,
  canonicalReasonFrom,
} from '../src/lib/insights/replacement-reason';

const APPLY = process.argv.includes('--apply');
const sinceArg = process.argv.indexOf('--since');
const SINCE = sinceArg > -1 ? process.argv[sinceArg + 1] : '2026-01-01';

interface Candidate {
  id: string;
  name: string;
  createdAt: string;
  email: string | null;
  tags: string[];
  tag: string;
  source: 'legacy tag' | 'customer email';
  evidence: string;
}

async function main() {
  const shopify = await createShopifyClient();
  if (!shopify) throw new Error('No Shopify client - is the integration enabled?');

  console.log(`Scanning replacement orders since ${SINCE}${APPLY ? '' : '  (DRY RUN)'}\n`);

  const orders = await shopify.getReplacementOrdersForBackfill(SINCE);
  console.log(`${orders.length} replacement orders found`);

  const candidates: Candidate[] = [];
  let alreadyCanonical = 0;
  let noReason = 0;

  for (const order of orders) {
    const lower = order.tags.map((t) => t.trim().toLowerCase());
    const canonical = canonicalReasonFrom(order.tags);

    // Already carries the canonical tag itself - nothing to do.
    if (canonical && lower.includes(canonical)) {
      alreadyCanonical++;
      continue;
    }

    if (canonical) {
      const legacy = order.tags.find(
        (t) => canonicalReasonFrom([t]) === canonical
      );
      candidates.push({
        id: order.id,
        name: order.name,
        createdAt: order.createdAt.slice(0, 10),
        email: order.email,
        tags: order.tags,
        tag: canonical,
        source: 'legacy tag',
        evidence: legacy || '',
      });
      continue;
    }

    // No reason at all: read the customer's own words.
    if (!order.email) {
      noReason++;
      continue;
    }
    const created = new Date(order.createdAt);
    const threads = await prisma.thread.findMany({
      where: { customerEmail: { equals: order.email, mode: 'insensitive' } },
      select: {
        messages: {
          where: {
            direction: 'INBOUND',
            sentAt: {
              gte: new Date(created.getTime() - 45 * 24 * 60 * 60 * 1000),
              lte: new Date(created.getTime() + 2 * 24 * 60 * 60 * 1000),
            },
          },
          select: { bodyText: true },
          orderBy: { sentAt: 'asc' },
        },
      },
    });
    const text = threads
      .flatMap((t) => t.messages)
      .map((m) => customerWordsOnly(m.bodyText || ''))
      .join(' \n ');
    const detected = detectReplacementReason(text);
    if (!detected) {
      noReason++;
      continue;
    }
    candidates.push({
      id: order.id,
      name: order.name,
      createdAt: order.createdAt.slice(0, 10),
      email: order.email,
      tags: order.tags,
      tag: detected.tag,
      source: 'customer email',
      evidence: detected.phrase,
    });
  }

  const byTag = new Map<string, number>();
  const bySource = new Map<string, number>();
  for (const c of candidates) {
    byTag.set(c.tag, (byTag.get(c.tag) || 0) + 1);
    bySource.set(c.source, (bySource.get(c.source) || 0) + 1);
  }

  console.log(`\n${alreadyCanonical} already canonical, ${noReason} have no reason to infer`);
  console.log(`${candidates.length} orders would get a tag:\n`);
  for (const [tag, n] of [...byTag.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tag.padEnd(28)} ${n}`);
  }
  console.log('\nby source:');
  for (const [src, n] of bySource) console.log(`  ${src.padEnd(28)} ${n}`);

  console.log('\nSample of what would be written:');
  for (const c of candidates.slice(0, 15)) {
    console.log(`  ${c.name} ${c.createdAt}  + ${c.tag}`);
    console.log(`      via ${c.source}: "${c.evidence.slice(0, 90)}"`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN - nothing written. Re-run with --apply to write these tags.');
    return;
  }

  console.log('\nWriting tags...');
  let ok = 0;
  const failures: { name: string; error: string }[] = [];
  for (const c of candidates) {
    const result = await shopify.addOrderTags(c.id, [c.tag]);
    if (result.success) {
      ok++;
      if (ok % 25 === 0) console.log(`  ${ok}/${candidates.length}`);
    } else {
      failures.push({ name: c.name, error: result.error || 'unknown' });
    }
  }
  console.log(`\nTagged ${ok} orders, ${failures.length} failed`);
  for (const f of failures.slice(0, 20)) console.log(`  ${f.name}: ${f.error}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
