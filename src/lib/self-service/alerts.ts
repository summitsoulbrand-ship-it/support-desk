/**
 * Loud operator alerts for self-service FAILURES.
 *
 * The success path already emails support@ (see email.ts). This module covers
 * the opposite case: an automated customer action failed or half-failed, and a
 * human must know NOW. Silent failure is the one unforgivable failure - a
 * customer who saw an error will not retry forever, and a half-done state
 * (e.g. Printify cancelled but Shopify not refunded) is invisible unless it
 * pings Pati.
 *
 * Posts to the #escalations Slack webhook AND emails support@ (which lands in
 * the desk inbox as a thread). Best-effort on both channels, never throws.
 */

import { postToSlack } from '@/lib/slack';
import { createOutboundEmailSender } from '@/lib/email';
import { selfServiceMonitor } from '@/lib/self-service/monitor';
import { logAction } from '@/lib/audit';

const SUPPORT_ADDRESS = 'support@summitsoul.shop';

export interface SelfServiceFailure {
  /** Which portal flow failed. */
  flow: 'cancel' | 'withdraw' | 'status' | 'address-change' | 'item-change' | 'upsell-merge';
  orderName: string;
  /** What was being attempted when it failed. */
  step: string;
  /** The error, verbatim where possible. */
  error: string;
  /** What a human must do now - the alert is useless without this. */
  humanAction: string;
  customerEmail?: string | null;
  detail?: Record<string, unknown>;
}

export async function notifySelfServiceFailure(
  f: SelfServiceFailure
): Promise<void> {
  const lines = [
    `Self-service ${f.flow} FAILED - order ${f.orderName}`,
    `Step: ${f.step}`,
    `Error: ${f.error}`,
    `Do now: ${f.humanAction}`,
  ];
  if (f.customerEmail) lines.push(`Customer: ${f.customerEmail}`);
  if (f.detail && Object.keys(f.detail).length > 0) {
    lines.push(`Detail: ${JSON.stringify(f.detail)}`);
  }
  const text = lines.join('\n');

  // EVERY channel is independent. A dead webhook or a throwing monitor must not
  // stop the ones after it - losing the alert is how order #33185 (2026-08-06)
  // sat cancelled-but-unrefunded with nobody knowing. Each returns true only on
  // a confirmed delivery; postToSlack returns FALSE when the webhook env var is
  // missing, which is exactly the silent case we have to catch.
  const d = f.detail || {};
  const delivered: string[] = [];
  const failed: string[] = [];

  const attempt = async (name: string, fn: () => Promise<boolean>) => {
    try {
      if (await fn()) delivered.push(name);
      else failed.push(`${name} (not configured or refused)`);
    } catch (err) {
      failed.push(`${name} (${err instanceof Error ? err.message : 'threw'})`);
    }
  };

  await attempt('slack', () => postToSlack(`:rotating_light: ${text}`));
  // An upsell failure belongs in the upsells channel, next to the merges that
  // worked - but it still shouts in #escalations above, because a failed merge
  // means an item the customer paid for will not ship.
  await attempt('monitor', async () => {
    await selfServiceMonitor({
      text: `:rotating_light: ${text}`,
      shopifyOrderId: (d.shopifyOrderId as string) || null,
      printifyOrderId:
        (d.newPrintifyOrderId as string) ||
        (d.printifyOrderId as string) ||
        null,
      channel: f.flow === 'upsell-merge' ? 'upsell' : 'self-service',
    });
    return true;
  });
  await attempt('email', async () => {
    const sender = await createOutboundEmailSender();
    if (!sender) return false;
    try {
      await sender.sendMessage({
        to: [{ address: SUPPORT_ADDRESS }],
        fromName: 'Summit Soul',
        subject: `[Self-service ALERT] ${f.flow} failed - order ${f.orderName}`,
        bodyText: text,
      });
      return true;
    } finally {
      await sender.disconnect().catch(() => undefined);
    }
  });

  // Durable record regardless of channel health: the DB is the one place that
  // cannot be silently misconfigured, and this surfaces in the app's action log.
  await logAction({
    userName: 'system',
    action: 'SELF_SERVICE_FAILURE',
    orderName: f.orderName,
    summary: `Self-service ${f.flow} failed at "${f.step}" - ${f.error}`,
    metadata: {
      ...f,
      alertsDelivered: delivered,
      alertsFailed: failed,
    },
  });

  if (delivered.length === 0) {
    // Nothing reached a human. Loud, greppable, and distinct from routine noise.
    console.error(
      `[self-service/alerts] CRITICAL: no alert channel delivered for order ` +
        `${f.orderName} (${failed.join('; ')}). Alert text follows:\n${text}`
    );
  } else if (failed.length > 0) {
    console.warn(
      `[self-service/alerts] partial delivery for ${f.orderName}: ` +
        `ok=[${delivered.join(', ')}] failed=[${failed.join('; ')}]`
    );
  }
}
