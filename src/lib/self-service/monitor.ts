/**
 * The launch-monitoring feed line builder. Every self-service action posts one
 * line to the monitor Slack channel; this appends clickable Shopify + Printify
 * order links so Pati can jump straight to either side. Best-effort - link
 * resolution never blocks or throws.
 */

import { postToSelfServiceMonitor } from '@/lib/slack';
import { createShopifyClient } from '@/lib/shopify';
import { createPrintifyClient } from '@/lib/printify';

export async function selfServiceMonitor(opts: {
  text: string;
  /** Shopify order gid (gid://shopify/Order/123) */
  shopifyOrderId?: string | null;
  /** Printify order id (prefer the CURRENT live copy) */
  printifyOrderId?: string | null;
}): Promise<void> {
  const parts = [opts.text];
  try {
    if (opts.shopifyOrderId) {
      const shopify = await createShopifyClient();
      const domain = shopify?.getStoreDomain();
      const legacy = opts.shopifyOrderId.replace(/^gid:\/\/shopify\/\w+\//, '');
      if (domain) parts.push(`Shopify: https://${domain}/admin/orders/${legacy}`);
    }
  } catch {
    // link best-effort
  }
  try {
    if (opts.printifyOrderId) {
      const printify = await createPrintifyClient();
      const shopId = printify?.getShopId();
      parts.push(
        shopId
          ? `Printify: https://printify.com/app/store/${shopId}/order/${opts.printifyOrderId}`
          : `Printify: https://printify.com/app/orders/${opts.printifyOrderId}`
      );
    }
  } catch {
    // link best-effort
  }
  await postToSelfServiceMonitor(parts.join(' | ')).catch(() => undefined);
}
