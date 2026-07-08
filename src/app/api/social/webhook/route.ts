/**
 * Meta Webhook Endpoint
 * Receives real-time comment notifications from Facebook/Instagram
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { processWebhookEvent } from '@/lib/social/sync';
import { getMetaCredentials } from '@/lib/social/meta-credentials';

/**
 * Secrets resolve env-first, then the encrypted Admin > Integrations > Meta
 * store (same source the OAuth flow uses), so no extra env plumbing is
 * needed to arm the receiver. Cached: Meta can deliver bursts of events and
 * the secret does not change between deploys.
 */
let cachedSecrets: { appSecret: string; verifyToken: string } | null = null;
async function getWebhookSecrets(): Promise<{ appSecret: string; verifyToken: string }> {
  if (cachedSecrets) return cachedSecrets;
  const envSecret = process.env.META_APP_SECRET || '';
  const envVerify = process.env.META_WEBHOOK_VERIFY_TOKEN || '';
  let creds = null;
  if (!envSecret || !envVerify) {
    try {
      creds = await getMetaCredentials();
    } catch (err) {
      console.error('[webhook] credential lookup failed:', err);
    }
  }
  cachedSecrets = {
    appSecret: envSecret || creds?.appSecret || '',
    verifyToken: envVerify || creds?.webhookVerifyToken || '',
  };
  return cachedSecrets;
}

/**
 * Verify webhook signature
 */
function verifySignature(payload: string, signature: string, appSecret: string): boolean {
  if (!appSecret || !signature) {
    return false;
  }

  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', appSecret)
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

  // Verify the mode and token (empty verify token = receiver not armed)
  const { verifyToken } = await getWebhookSecrets();
  if (mode === 'subscribe' && verifyToken && token === verifyToken) {
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

    // Verify signature. Fail CLOSED in production when the secret is missing -
    // without it we cannot authenticate the sender. Dev stays lenient so local
    // testing works without Meta credentials.
    const { appSecret } = await getWebhookSecrets();
    if (!appSecret) {
      if (process.env.NODE_ENV === 'production') {
        console.error(
          'Meta app secret unavailable (env + integration store) - rejecting webhook (fail closed in production)'
        );
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    } else if (!verifySignature(rawBody, signature, appSecret)) {
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
