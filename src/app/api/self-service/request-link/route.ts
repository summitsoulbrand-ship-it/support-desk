/**
 * POST /api/self-service/request-link
 *
 * Public, unauthenticated. Body: { orderNumber, email }.
 * If the order exists AND the email matches the order, emails a single-use magic
 * link to the address ON the order. Always returns the same generic response so
 * the endpoint can't be used to probe which orders or emails exist.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkRateLimitAsync } from '@/lib/rate-limit';
import { clientIp } from '@/lib/client-ip';
import { lookupOrderByNumberAndEmail, isEuOrder } from '@/lib/self-service/orders';
import { createSelfServiceToken, TOKEN_TTL_MINUTES } from '@/lib/self-service/tokens';
import { sendCancelMagicLink, sendWithdrawMagicLink } from '@/lib/self-service/email';

const bodySchema = z.object({
  orderNumber: z.string().min(1).max(40),
  email: z.string().email().max(200),
});

// Same generic answer for matched / not-found / email-mismatch (fresh response
// per request - a Response body can only be sent once).
const generic = () =>
  NextResponse.json({
    ok: true,
    message:
      'If that order number and email match an order, we just sent a cancellation link to that email address.',
  });

// Hard ceiling on magic-link emails per hour ACROSS ALL callers, so a
// distributed enumeration attempt rotating IPs and emails still can't spam
// unbounded email volume. Counted only when a link would actually be sent.
const GLOBAL_SEND_LIMIT = 30;
const GLOBAL_SEND_WINDOW_MS = 60 * 60 * 1000;

function baseUrl(request: NextRequest): string {
  const raw = (
    process.env.SELF_SERVICE_BASE_URL ||
    process.env.NEXTAUTH_URL ||
    new URL(request.url).origin
  )
    .trim()
    .replace(/\/$/, '');
  // Railway sets NEXTAUTH_URL without a scheme (host only); ensure https so the
  // magic link is absolute and clickable.
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export async function POST(request: NextRequest) {
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const ip = clientIp(request);
  const email = parsed.email.trim().toLowerCase();

  // Throttle by IP and by email to blunt enumeration / spam.
  const ipLimit = await checkRateLimitAsync(`ss-link-ip:${ip}`, 8, 15 * 60 * 1000);
  const emailLimit = await checkRateLimitAsync(`ss-link-email:${email}`, 4, 15 * 60 * 1000);
  if (!ipLimit.success || !emailLimit.success) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again in a little while.' },
      { status: 429 }
    );
  }

  try {
    const result = await lookupOrderByNumberAndEmail(parsed.orderNumber, email);

    // No order with that number exists at all -> tell the customer, so a typo or
    // a pasted email subject line ("Order #24659 confirmed") doesn't silently
    // dead-end. This reveals only that an order number is unused; it never
    // confirms a real order's email (an email mismatch stays generic below).
    if (result.status === 'not_found') {
      return NextResponse.json(
        {
          notFound: true,
          message:
            "We couldn't find an order with that number. Please check the order number from your confirmation email (just the digits, like 24659) and the email you used at checkout, then try again. Still stuck? Email support@summitsoul.shop.",
        },
        { status: 404 }
      );
    }

    const state = result.status === 'ok' ? result.state : null;

    // Email mismatch / unavailable -> generic (no disclosure).
    // Already cancelled -> generic too; nothing to do.
    if (state && state.eligibility.reason !== 'already_cancelled') {
      // Global sliding cap on actual sends. Checked here (not up top) so probes
      // that never match an order can't burn the budget for real customers.
      // On cap, suppress the email but stay generic - no signal to the caller.
      const globalLimit = await checkRateLimitAsync(
        'ss-link-send-global',
        GLOBAL_SEND_LIMIT,
        GLOBAL_SEND_WINDOW_MS
      );
      if (!globalLimit.success) {
        console.warn(
          '[self-service/request-link] global send cap reached; suppressing link email'
        );
        return generic();
      }

      const onFileEmail = (
        state.shopifyOrder.customerEmail || email
      ).toLowerCase();

      // The legal regime follows the ORDER's ship-to country, not the page the
      // customer happened to use: EU orders get the statutory withdrawal flow,
      // everyone else keeps the standard pre-production cancel flow.
      const eu = isEuOrder(state.shopifyOrder);

      const raw = await createSelfServiceToken({
        purpose: eu ? 'WITHDRAW' : 'CANCEL',
        shopifyOrderId: state.shopifyOrder.id,
        shopifyOrderName: state.shopifyOrder.name,
        email: onFileEmail,
        printifyOrderId: state.printifyOrderId,
        requestIp: ip,
      });

      const path = eu ? '/self-service/withdraw' : '/self-service/cancel';
      const url = `${baseUrl(request)}${path}?token=${encodeURIComponent(raw)}`;
      // Always send to the address ON the order, never an attacker-typed one.
      if (eu) {
        await sendWithdrawMagicLink({
          to: onFileEmail,
          orderName: state.shopifyOrder.name,
          url,
          ttlMinutes: TOKEN_TTL_MINUTES,
        });
      } else {
        await sendCancelMagicLink({
          to: onFileEmail,
          orderName: state.shopifyOrder.name,
          url,
          ttlMinutes: TOKEN_TTL_MINUTES,
        });
      }
    }
  } catch (err) {
    // Log server-side, but still return generic so we don't leak signal.
    console.error('[self-service/request-link] error:', err);
  }

  return generic();
}
