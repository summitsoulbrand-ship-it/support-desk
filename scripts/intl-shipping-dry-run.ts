/**
 * Dry run of the international shipping alarm: prints what it would flag over a
 * chosen window without emailing or writing anything.
 *
 *   npx tsx scripts/intl-shipping-dry-run.ts [lookbackHours] [thresholdUsd]
 *
 * Credentials come from PRINTIFY_API_TOKEN / PRINTIFY_SHOP_ID in the
 * environment when present, so this works against live data from a machine
 * whose local database copy holds a stale token. Without them it falls back to
 * the credential store, exactly like the worker does.
 */
import { runIntlShippingAlarm } from '../src/lib/printify/intl-shipping-alarm';
import { PrintifyClient } from '../src/lib/printify';

async function main() {
  const lookbackHours = parseInt(process.argv[2] || '720', 10);
  const thresholdUsd = parseFloat(process.argv[3] || '5');

  const token = process.env.PRINTIFY_API_TOKEN;
  const shopId = process.env.PRINTIFY_SHOP_ID;
  const printifyClient =
    token && shopId ? new PrintifyClient({ apiToken: token, shopId }) : undefined;

  // Shopify credentials live only in the store, so a local run compares against
  // the fallback rate table instead. Flagged as "estimate" in the output.
  const shopifyClient = process.env.SHOPIFY_FROM_STORE ? undefined : null;

  const r = await runIntlShippingAlarm({
    lookbackHours,
    thresholdUsd,
    dryRun: true,
    printifyClient,
    shopifyClient,
  });

  console.log(
    `scanned=${r.scanned} international=${r.international} flagged=${r.findings.length}`
  );
  for (const f of r.findings) {
    console.log(
      `\n${f.orderName}  ${f.country}  ${f.createdAt.slice(0, 10)}  [${f.status}]\n` +
        `  Printify $${f.shippingChargedUsd.toFixed(2)} vs collected ` +
        `$${f.shippingCollectedUsd.toFixed(2)} (${f.collectedSource}) -> out of pocket $${f.gapUsd.toFixed(2)}`
    );
    for (const l of f.misroutedLines) {
      console.log(
        `  misrouted: ${l.title} (${l.variant}) made in ${l.printedIn}, $${l.shippingUsd.toFixed(2)}`
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
