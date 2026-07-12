/**
 * Emails for the self-service portal:
 *  - the magic link (sent to the address on the order) - branded to match the
 *    Shopify order emails (logo header, footer, brand green)
 *  - the support@ notification (sent every time a customer self-cancels) - plain,
 *    it's an internal ops email
 *
 * Both go through the same outbound Zoho sender the support desk already uses,
 * so they send from the Summit Soul support mailbox. The support notification
 * also lands back in that inbox and is synced into the desk as a thread, so
 * Pati gets a record in the app for free.
 */

import { createOutboundEmailSender } from '@/lib/email';
import { postToSelfServiceMonitor } from '@/lib/slack';

const SUPPORT_ADDRESS = 'support@summitsoul.shop';
const BRAND_GREEN = '#2f5d3a';
const INK = '#1f2421';
const MUTED = '#6b7280';
const LOGO_URL =
  'https://summitsoul.shop/cdn/shop/files/Untitled_500_x_200_px_1.png?v=1748392918&width=400';
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Branded shell mirroring the Shopify order emails: logo header, white card on a
 * light background, footer with a reply prompt. `preheader` is the hidden
 * inbox-preview line.
 */
function brandedShell(inner: string, preheader: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f4f6f3;">
  <span style="display:none!important;opacity:0;color:#f4f6f3;font-size:1px;line-height:1px;max-height:0;max-width:0;overflow:hidden;">${preheader}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f3;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;">
        <tr><td style="padding:28px 32px 4px;">
          <img src="${LOGO_URL}" alt="Summit Soul" width="150" style="display:block;border:0;outline:none;text-decoration:none;height:auto;">
        </td></tr>
        <tr><td style="padding:16px 32px 8px;font-family:${FONT};color:${INK};font-size:16px;line-height:1.5;">
          ${inner}
        </td></tr>
        <tr><td style="padding:20px 32px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid #ececec;padding-top:18px;font-family:${FONT};color:${MUTED};font-size:13px;line-height:1.5;">
            Questions? Just reply to this email or reach out at <a href="mailto:${SUPPORT_ADDRESS}" style="color:${BRAND_GREEN};">${SUPPORT_ADDRESS}</a>. We'd love to hear from you!<br><br>Summit Soul
          </td></tr></table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/** A centered, email-safe green button. */
function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr>
    <td style="background:${BRAND_GREEN};border-radius:8px;">
      <a href="${href}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;">${label}</a>
    </td></tr></table>`;
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

  const bodyHtml = brandedShell(
    `
    <h1 style="margin:0 0 14px;font-size:22px;color:${INK};">Cancel order ${params.orderName}?</h1>
    <p style="margin:0 0 4px;">You (or someone using your email) asked to cancel this order. Click below to confirm. You'll see the order and can cancel it for a full refund - as long as it hasn't started printing yet.</p>
    ${button(params.url, 'Review &amp; cancel my order')}
    <p style="margin:0;color:${MUTED};font-size:13px;">This link expires in ${params.ttlMinutes} minutes and can only be used once. If you didn't request this, ignore this email - nothing will change.</p>
  `,
    `Confirm cancelling order ${params.orderName} - link expires in ${params.ttlMinutes} minutes.`
  );

  try {
    const res = await sender.sendMessage({
      to: [{ address: params.to }],
      fromName: 'Summit Soul',
      subject,
      bodyText,
      bodyHtml,
    });
    return { success: res.success, error: res.error };
  } finally {
    await sender.disconnect().catch(() => undefined);
  }
}

/**
 * EU right-of-withdrawal magic link. Same secure mechanism as the cancel link,
 * but framed as the statutory "withdraw from contract" function the EU requires.
 */
export async function sendWithdrawMagicLink(params: {
  to: string;
  orderName: string;
  url: string;
  ttlMinutes: number;
}): Promise<{ success: boolean; error?: string }> {
  const sender = await createOutboundEmailSender();
  if (!sender) return { success: false, error: 'No outbound email sender configured' };

  const subject = `Confirm withdrawing from order ${params.orderName}`;
  const bodyText = [
    `You (or someone using your email) asked to withdraw from Summit Soul order ${params.orderName} under your EU right of withdrawal.`,
    ``,
    `Confirm your withdrawal here (link expires in ${params.ttlMinutes} minutes):`,
    params.url,
    ``,
    `If you did not request this, you can ignore this email - nothing will change.`,
    ``,
    `Summit Soul`,
  ].join('\n');

  const bodyHtml = brandedShell(
    `
    <h1 style="margin:0 0 14px;font-size:22px;color:${INK};">Withdraw from order ${params.orderName}?</h1>
    <p style="margin:0 0 4px;">You (or someone using your email) asked to withdraw from this order under your EU 14-day right of withdrawal. Click below to confirm. You'll see the order and can complete your withdrawal for a full refund to your original payment method.</p>
    ${button(params.url, 'Review &amp; withdraw from contract')}
    <p style="margin:0;color:${MUTED};font-size:13px;">This link expires in ${params.ttlMinutes} minutes and can only be used once. If you didn't request this, ignore this email - nothing will change.</p>
  `,
    `Confirm withdrawing from order ${params.orderName} - link expires in ${params.ttlMinutes} minutes.`
  );

  try {
    const res = await sender.sendMessage({
      to: [{ address: params.to }],
      fromName: 'Summit Soul',
      subject,
      bodyText,
      bodyHtml,
    });
    return { success: res.success, error: res.error };
  } finally {
    await sender.disconnect().catch(() => undefined);
  }
}

/**
 * Manage-portal magic link: one link to see status and make one change
 * (cancel, size/color, address). Sent to the address ON the order.
 */
export async function sendManageMagicLink(params: {
  to: string;
  orderName: string;
  url: string;
  ttlMinutes: number;
}): Promise<{ success: boolean; error?: string }> {
  const sender = await createOutboundEmailSender();
  if (!sender) return { success: false, error: 'No outbound email sender configured' };

  const subject = `Your Summit Soul order ${params.orderName} - status & changes`;
  const bodyText = [
    `You (or someone using your email) asked for a link to view or change Summit Soul order ${params.orderName}.`,
    ``,
    `See your order's status, fix the shipping address, change a size or color, or cancel - all here (link expires in ${params.ttlMinutes} minutes):`,
    params.url,
    ``,
    `If you did not request this, you can ignore this email - nothing will change.`,
    ``,
    `Summit Soul`,
  ].join('\n');

  const bodyHtml = brandedShell(
    `
    <h1 style="margin:0 0 14px;font-size:22px;color:${INK};">Your order ${params.orderName}</h1>
    <p style="margin:0 0 4px;">Here is your secure link. You can check where your order is, fix the shipping address, change a size or color, or cancel - as long as it hasn't started printing yet.</p>
    ${button(params.url, 'View my order')}
    <p style="margin:0;color:${MUTED};font-size:13px;">This link expires in ${params.ttlMinutes} minutes. If you didn't request this, ignore this email - nothing will change.</p>
  `,
    `View or change order ${params.orderName} - link expires in ${params.ttlMinutes} minutes.`
  );

  try {
    const res = await sender.sendMessage({
      to: [{ address: params.to }],
      fromName: 'Summit Soul',
      subject,
      bodyText,
      bodyHtml,
    });
    return { success: res.success, error: res.error };
  } finally {
    await sender.disconnect().catch(() => undefined);
  }
}

/**
 * Branded confirmation after a successful self-service change (address fix,
 * size/color swap). The customer's durable record of what changed.
 */
export async function sendSelfServiceChangeConfirmation(params: {
  to: string;
  orderName: string;
  heading: string; // e.g. "Shipping address updated"
  changeSummary: string; // one plain sentence describing exactly what changed
  /** Picture of the (new) item, e.g. the new color's mockup */
  imageUrl?: string | null;
}): Promise<{ success: boolean; error?: string }> {
  const sender = await createOutboundEmailSender();
  if (!sender) return { success: false, error: 'No outbound email sender configured' };

  const subject = `${params.heading} - order ${params.orderName}`;
  const bodyText = [
    params.changeSummary,
    ``,
    `Everything else about your order stays the same. If this wasn't you or something looks off, reply to this email right away.`,
    ``,
    `Summit Soul`,
  ].join('\n');

  const imageBlock = params.imageUrl
    ? `<div style="margin:16px 0;"><img src="${params.imageUrl}" alt="Your item" width="180" style="display:block;border:0;border-radius:10px;max-width:100%;height:auto;"></div>`
    : '';

  const bodyHtml = brandedShell(
    `
    <h1 style="margin:0 0 14px;font-size:22px;color:${INK};">${params.heading}</h1>
    <p style="margin:0 0 4px;">${params.changeSummary}</p>
    ${imageBlock}
    <p style="margin:12px 0 0;color:${MUTED};font-size:13px;">Everything else about your order stays the same. If this wasn't you or something looks off, reply to this email right away.</p>
  `,
    `${params.heading} for order ${params.orderName}.`
  );

  try {
    const res = await sender.sendMessage({
      to: [{ address: params.to }],
      fromName: 'Summit Soul',
      subject,
      bodyText,
      bodyHtml,
    });
    return { success: res.success, error: res.error };
  } finally {
    await sender.disconnect().catch(() => undefined);
  }
}

/**
 * Durable-medium acknowledgment of a completed withdrawal. EU Directive (EU)
 * 2023/2673 requires the trader to confirm receipt of the withdrawal on a
 * durable medium "without undue delay" - this email is that record.
 */
export async function sendWithdrawalConfirmation(params: {
  to: string;
  orderName: string;
  total: string;
  shipped: boolean;
}): Promise<{ success: boolean; error?: string }> {
  const sender = await createOutboundEmailSender();
  if (!sender) return { success: false, error: 'No outbound email sender configured' };

  const subject = `Withdrawal confirmed - order ${params.orderName}`;
  const returnLineText = params.shipped
    ? `\nYour order has already shipped. We've refunded you in full now - please return the item to us (reply to this email and we'll share the return address). Standard postage is on us.\n`
    : '';
  const returnLineHtml = params.shipped
    ? `<p style="margin:0 0 4px;">Your order has already shipped, so we've refunded you in full now. Please return the item to us - just reply to this email and we'll share the return address. Standard postage is on us.</p>`
    : '';

  const bodyText = [
    `We've received your withdrawal from Summit Soul order ${params.orderName} under your EU right of withdrawal.`,
    ``,
    `A refund of ${params.total} is on its way to your original payment method.`,
    returnLineText,
    `This email confirms your withdrawal. Keep it for your records.`,
    ``,
    `Summit Soul`,
  ].join('\n');

  const bodyHtml = brandedShell(
    `
    <h1 style="margin:0 0 14px;font-size:22px;color:${INK};">Withdrawal confirmed</h1>
    <p style="margin:0 0 4px;">We've received your withdrawal from order <strong>${params.orderName}</strong> under your EU right of withdrawal.</p>
    <p style="margin:0 0 4px;">A refund of <strong>${params.total}</strong> is on its way to your original payment method.</p>
    ${returnLineHtml}
    <p style="margin:12px 0 0;color:${MUTED};font-size:13px;">This email confirms your withdrawal. Please keep it for your records.</p>
  `,
    `Withdrawal confirmed for order ${params.orderName} - refund of ${params.total} on its way.`
  );

  try {
    const res = await sender.sendMessage({
      to: [{ address: params.to }],
      fromName: 'Summit Soul',
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
  // Launch-monitoring feed: every successful portal action, one line.
  await postToSelfServiceMonitor(
    `:white_check_mark: ${params.orderName} - ${params.action} | ${params.customerEmail}${params.total ? ` | ${params.total}` : ''}`
  ).catch(() => undefined);

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
      fromName: 'Summit Soul',
      subject,
      bodyText: lines.join('\n'),
      bodyHtml: `<div style="font-family:${FONT};color:${INK};font-size:14px;line-height:1.5;max-width:520px;"><h3 style="color:${BRAND_GREEN};margin:0 0 8px;">Self-service action</h3>${lines
        .slice(2)
        .filter(Boolean)
        .map((l) => `<div>${l}</div>`)
        .join('')}</div>`,
    });
  } finally {
    await sender.disconnect().catch(() => undefined);
  }
}
