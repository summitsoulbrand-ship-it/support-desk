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

import { postToSlack, postToSelfServiceMonitor } from '@/lib/slack';
import { createOutboundEmailSender } from '@/lib/email';

const SUPPORT_ADDRESS = 'support@summitsoul.shop';

export interface SelfServiceFailure {
  /** Which portal flow failed. */
  flow: 'cancel' | 'withdraw' | 'status' | 'address-change' | 'item-change';
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

  // Slack first (fastest eyeballs), then the support inbox for a durable record.
  // Failures also mirror into the self-service monitor feed so the launch
  // channel shows the complete picture, good and bad.
  await postToSlack(`:rotating_light: ${text}`).catch(() => undefined);
  await postToSelfServiceMonitor(`:rotating_light: ${text}`).catch(() => undefined);

  try {
    const sender = await createOutboundEmailSender();
    if (!sender) return;
    try {
      await sender.sendMessage({
        to: [{ address: SUPPORT_ADDRESS }],
        fromName: 'Summit Soul',
        subject: `[Self-service ALERT] ${f.flow} failed - order ${f.orderName}`,
        bodyText: text,
      });
    } finally {
      await sender.disconnect().catch(() => undefined);
    }
  } catch (err) {
    console.error('[self-service/alerts] alert email failed:', err);
  }
}
