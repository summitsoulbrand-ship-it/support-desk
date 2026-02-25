/**
 * Meta Webhook Endpoint
 * Receives real-time comment notifications from Facebook/Instagram
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { processWebhookEvent } from '@/lib/social/sync';

// Get app secret from environment (for signature verification)
const APP_SECRET = process.env.META_APP_SECRET || '';
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || '';

/**
 * Verify webhook signature
 */
function verifySignature(payload: string, signature: string): boolean {
  if (!APP_SECRET || !signature) {
    return false;
  }

  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', APP_SECRET)
    .update(payload)
    .digest('hex')}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}

/**
 * GET - Webhook verification (Meta challenge-response)
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  // Verify the mode and token
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    return new NextResponse(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  console.log('Webhook verification failed');
  return NextResponse.json({ error: 'Verification failed' }, { status: 403 });
}

/**
 * POST - Receive webhook events
 */
export async function POST(request: NextRequest) {
  try {
    // Get raw body for signature verification
    const rawBody = await request.text();
    const signature = request.headers.get('x-hub-signature-256') || '';

    // Verify signature (skip in development if not configured)
    if (APP_SECRET && !verifySignature(rawBody, signature)) {
      console.error('Invalid webhook signature');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }

    // Parse the payload
    const body = JSON.parse(rawBody);

    // Meta sends batched events
    if (body.object !== 'page' && body.object !== 'instagram') {
      return NextResponse.json({ received: true });
    }

    // Process each entry asynchronously (don't block the webhook response)
    const entries = body.entry || [];

    // Respond immediately (Meta requires quick responses)
    setImmediate(async () => {
      for (const entry of entries) {
        try {
          await processWebhookEvent(entry);
        } catch (err) {
          console.error('Error processing webhook entry:', err);
        }
      }
    });

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    // Still return 200 to prevent Meta from retrying
    return NextResponse.json({ received: true });
  }
}
