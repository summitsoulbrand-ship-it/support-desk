/**
 * Printify webhook receiver
 * Handles order:shipment:created / order:shipment:delivered to push tracking
 * from relinked (recreated) Printify orders back onto the original Shopify
 * order. The worker's poll loop covers the same ground, so a missed webhook
 * is never fatal.
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import prisma from '@/lib/db';
import { pushFulfillmentForRelink } from '@/lib/printify/relink';

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

    if (!topic.startsWith('order:shipment') || !printifyOrderId) {
      // Not a shipment event we care about - acknowledge and move on
      return NextResponse.json({ ok: true, ignored: true });
    }

    const relink = await prisma.orderRelink.findUnique({
      where: { printifyOrderId },
    });

    if (relink && relink.status !== 'FULFILLED_PUSHED' && relink.status !== 'CANCELLED') {
      // Two quick API calls - do them inline, Printify allows slow-ish ACKs
      const result = await pushFulfillmentForRelink(relink);
      return NextResponse.json({ ok: true, pushed: result.success });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Printify webhook error:', err);
    // Return 200 so Printify doesn't disable the webhook; poll loop will catch up
    return NextResponse.json({ ok: false });
  }
}
