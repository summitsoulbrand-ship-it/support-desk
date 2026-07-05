/**
 * Printify webhook receiver
 * Two jobs, both idempotent and both backstopped by the worker's poll loop
 * (a missed webhook is never fatal):
 *  - order:shipment:* on a relinked (recreated) order pushes tracking back
 *    onto the original Shopify order
 *  - EVERY order:* event refreshes that one order in the printify_orders
 *    cache, so production/shipping status is push-fresh and the poll sweep
 *    can run at safety-net cadence instead of re-walking the window
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import prisma from '@/lib/db';
import { pushFulfillmentForRelink } from '@/lib/printify/relink';
import { refreshOrderInCache } from '@/lib/printify/sync';

function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!signatureHeader) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');
  const provided = signatureHeader.replace(/^sha256=/, '').trim();

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(provided, 'hex')
    );
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();

    const signature =
      request.headers.get('x-pfy-signature') ||
      request.headers.get('x-printify-signature');

    // Fail CLOSED in production when the secret is missing - without it we
    // cannot authenticate the sender, and the worker's poll loop covers any
    // missed events. Dev stays lenient for local testing without a secret.
    const secret = process.env.PRINTIFY_WEBHOOK_SECRET;
    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        console.error(
          'PRINTIFY_WEBHOOK_SECRET is not set - rejecting webhook (fail closed in production)'
        );
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    } else if (!verifySignature(rawBody, signature, secret)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    let payload: {
      topic?: string;
      type?: string;
      resource?: { id?: string | number; data?: { shop_order_id?: string | number } };
    };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const topic = payload.topic || payload.type || '';
    const printifyOrderId = payload.resource?.id?.toString();

    if (!topic.startsWith('order:') || !printifyOrderId) {
      // Not an order event we care about - acknowledge and move on
      return NextResponse.json({ ok: true, ignored: true });
    }

    // Relink push-back: a shipment on a recreated order gets its tracking
    // written onto the original Shopify order.
    let pushed: boolean | undefined;
    if (topic.startsWith('order:shipment')) {
      const relink = await prisma.orderRelink.findUnique({
        where: { printifyOrderId },
      });
      if (
        relink &&
        relink.status !== 'FULFILLED_PUSHED' &&
        relink.status !== 'CANCELLED'
      ) {
        // Two quick API calls - do them inline, Printify allows slow-ish ACKs
        const result = await pushFulfillmentForRelink(relink);
        pushed = result.success;
      }
    }

    // Push-driven cache: refresh this one order so production/shipping status
    // lands in printify_orders the moment it changes instead of waiting for
    // the next poll sweep. One API call; a failure is healed by the poll loop.
    const refreshed = await refreshOrderInCache(printifyOrderId);
    console.log(
      `[printify-webhook] ${topic} order=${printifyOrderId} cacheRefreshed=${refreshed}` +
        (pushed !== undefined ? ` relinkPushed=${pushed}` : '')
    );

    return NextResponse.json({ ok: true, refreshed, pushed });
  } catch (err) {
    console.error('Printify webhook error:', err);
    // Return 200 so Printify doesn't disable the webhook; poll loop will catch up
    return NextResponse.json({ ok: false });
  }
}
