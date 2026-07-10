/**
 * Daily escalation digest: one morning overview (7am Manila by default, so it
 * doubles as the VA's shift-start briefing) of everything that still needs
 * Pati's attention - escalated inbox threads (needsManual, unresolved) and
 * pending Printify escalations - oldest first, with direct links. Sent as an
 * email and mirrored to Slack. Skipped entirely when there is nothing open,
 * so an empty queue means an empty inbox, not a daily "all clear" email.
 */

import prisma from '@/lib/db';
import { createOutboundEmailSender } from '@/lib/email';
import { pendingEscalationsWhere } from '@/lib/queues';
import { postToSlack } from '@/lib/slack';

const DAY_MS = 24 * 60 * 60 * 1000;

function esc(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function age(from: Date): string {
  const days = Math.floor((Date.now() - from.getTime()) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

export interface EscalationDigestStats {
  threads: number;
  printify: number;
  sent: boolean;
}

export async function sendEscalationDigest(): Promise<EscalationDigestStats> {
  const [threads, printify] = await Promise.all([
    prisma.thread.findMany({
      where: { needsManual: true, manualResolvedAt: null },
      select: {
        id: true,
        subject: true,
        customerEmail: true,
        customerName: true,
        manualReason: true,
        updatedAt: true,
        lastMessageAt: true,
      },
      orderBy: { lastMessageAt: 'asc' },
      take: 50,
    }),
    prisma.printifyEscalation.findMany({
      where: pendingEscalationsWhere(),
      select: {
        orderNumber: true,
        customerName: true,
        customerEmail: true,
        resolution: true,
        issue: true,
        createdAt: true,
        threadId: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    }),
  ]);

  if (threads.length === 0 && printify.length === 0) {
    return { threads: 0, printify: 0, sent: false };
  }

  const base = process.env.NEXTAUTH_URL || 'https://selfservice.summitsoul.shop';
  const to =
    process.env.ESCALATION_EMAIL_TO ||
    process.env.EVAL_EMAIL_TO ||
    'summitsoulbrand@gmail.com';

  // --- Email (HTML) ---
  let html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px">`;
  html += `<h2 style="color:#9a3412">Open escalations - ${threads.length + printify.length} waiting</h2>`;
  if (threads.length > 0) {
    html += `<h3 style="margin-bottom:4px">Inbox threads (${threads.length})</h3>`;
    for (const t of threads) {
      const who = t.customerName ? `${t.customerName} (${t.customerEmail})` : t.customerEmail;
      html +=
        `<div style="margin:8px 0;padding:8px;border:1px solid #eee;border-radius:6px">` +
        `<b>${esc(t.subject || '(no subject)')}</b> <span style="color:#999;font-size:11px">${age(t.lastMessageAt)} old</span><br>` +
        `<span style="font-size:12px">${esc(who)}</span><br>` +
        `<span style="color:#9a3412;font-size:12px">${esc(t.manualReason || 'escalated for review')}</span><br>` +
        `<a href="${base}/inbox?thread=${t.id}" style="font-size:12px">Open thread</a></div>`;
    }
  }
  if (printify.length > 0) {
    html += `<h3 style="margin-bottom:4px">Printify escalations (${printify.length})</h3>`;
    for (const e of printify) {
      const who = e.customerName ? `${e.customerName}` : e.customerEmail || '';
      html +=
        `<div style="margin:8px 0;padding:8px;border:1px solid #eee;border-radius:6px">` +
        `<b>${esc(e.orderNumber)}</b> <span style="color:#999;font-size:11px">${age(e.createdAt)} old - ${esc(String(e.resolution))}</span><br>` +
        `<span style="font-size:12px">${esc(who)}</span><br>` +
        `<span style="color:#555;font-size:12px">${esc((e.issue || '').slice(0, 160))}</span><br>` +
        `<a href="${base}/late-orders" style="font-size:12px">Open Printify escalations</a></div>`;
    }
  }
  html += `</div>`;

  let sent = false;
  try {
    const sender = await createOutboundEmailSender();
    if (sender) {
      await sender.sendMessage({
        to: [{ address: to }],
        fromName: 'Summit Soul Desk',
        subject: `Open escalations: ${threads.length + printify.length} waiting (${threads.length} threads, ${printify.length} Printify)`,
        bodyHtml: html,
      });
      sent = true;
    }
  } catch (err) {
    console.error('[escalation-digest] email failed:', err);
  }

  // --- Slack mirror: THREAD escalations only (Pati 2026-07-11 - the channel
  // is "Jaki escalated something to you", not a Printify ops feed; Printify
  // items stay in the email overview and the in-app queue). Skipped entirely
  // when no thread escalations are open.
  if (threads.length > 0) {
    const lines: string[] = [
      `*Open escalations - ${threads.length} waiting for you*`,
    ];
    for (const t of threads) {
      lines.push(
        `• ${t.subject || '(no subject)'} - ${t.customerName || t.customerEmail} (${age(t.lastMessageAt)}): ${(t.manualReason || 'review').slice(0, 120)}\n  ${base}/inbox?thread=${t.id}`
      );
    }
    await postToSlack(lines.join('\n'));
  }

  return { threads: threads.length, printify: printify.length, sent };
}
