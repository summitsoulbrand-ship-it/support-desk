/**
 * Emails for the self-service portal:
 *  - the magic link (sent to the address on the order)
 *  - the support@ notification (sent every time a customer self-cancels)
 *
 * Both go through the same outbound Zoho sender the support desk already uses,
 * so they send from the Summit Soul support mailbox. The support notification
 * also lands back in that inbox and is synced into the desk as a thread, so
 * Pati gets a record in the app for free.
 */

import { createOutboundEmailSender } from '@/lib/email';

const SUPPORT_ADDRESS = 'support@summitsoul.shop';
const BRAND_GREEN = '#2f5d3a';

function shell(inner: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2421;line-height:1.5">${inner}</div>`;
}

export async function sendCancelMagicLink(params: {
  to: string;
  orderName: string;
  url: string;
  ttlMinutes: number;
}): Promise<{ success: boolean; error?: string }> {
  const sender = await createOutboundEmailSender();
  if (!sender) return { success: false, error: 'No outbound email sender configured' };

  const subject = `Confirm cancelling order ${params.orderName}`;
  const bodyText = [
    `You (or someone using your email) asked to cancel Summit Soul order ${params.orderName}.`,
    ``,
    `Confirm and cancel here (link expires in ${params.ttlMinutes} minutes):`,
    params.url,
    ``,
    `If you did not request this, you can ignore this email - nothing will change.`,
    ``,
    `Summit Soul`,
  ].join('\n');

  const bodyHtml = shell(`
    <h2 style="color:${BRAND_GREEN};margin:0 0 12px">Cancel order ${params.orderName}?</h2>
    <p>You (or someone using your email) asked to cancel this order. Click below to confirm. You will see the order and can cancel it for a full refund - as long as it has not started printing yet.</p>
    <p style="margin:24px 0">
      <a href="${params.url}" style="background:${BRAND_GREEN};color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;font-weight:600">Review &amp; cancel my order</a>
    </p>
    <p style="color:#6b7280;font-size:13px">This link expires in ${params.ttlMinutes} minutes and can only be used once. If you did not request this, ignore this email - nothing will change.</p>
    <p style="color:#6b7280;font-size:13px">Summit Soul</p>
  `);

  try {
    const res = await sender.sendMessage({
      to: [{ address: params.to }],
      subject,
      bodyText,
      bodyHtml,
    });
    return { success: res.success, error: res.error };
  } finally {
    await sender.disconnect().catch(() => undefined);
  }
}

export async function sendSelfServiceSupportNotice(params: {
  orderName: string;
  customerEmail: string;
  action: string; // e.g. "Cancelled + refunded"
  printifyCancelled: boolean;
  total?: string | null;
  requestIp?: string | null;
}): Promise<void> {
  const sender = await createOutboundEmailSender();
  if (!sender) return;

  const subject = `[Self-service] ${params.action} - order ${params.orderName}`;
  const lines = [
    `A customer used the self-service portal.`,
    ``,
    `Action: ${params.action}`,
    `Order: ${params.orderName}`,
    `Customer: ${params.customerEmail}`,
    `Order total: ${params.total ?? 'n/a'}`,
    `Printify order cancelled: ${params.printifyCancelled ? 'yes' : 'no (none linked or already handled)'}`,
    `Request IP: ${params.requestIp ?? 'unknown'}`,
    ``,
    `This was verified by an email magic link to the address on the order and a live production-status re-check at the moment of cancellation.`,
  ];

  try {
    await sender.sendMessage({
      to: [{ address: SUPPORT_ADDRESS }],
      subject,
      bodyText: lines.join('\n'),
      bodyHtml: shell(
        `<h3 style="color:${BRAND_GREEN};margin:0 0 8px">Self-service action</h3>` +
          lines
            .slice(2)
            .filter(Boolean)
            .map((l) => `<div>${l}</div>`)
            .join('')
      ),
    });
  } finally {
    await sender.disconnect().catch(() => undefined);
  }
}
