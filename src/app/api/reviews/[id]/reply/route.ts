/**
 * Review Reply API - Post/update replies to Judge.me reviews
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import { createJudgemeClient } from '@/lib/judgeme/client';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check permission - use REPLY_THREADS as it's similar functionality
    if (!hasPermission(session.user.role, 'REPLY_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;
    const reviewId = parseInt(id, 10);

    if (isNaN(reviewId)) {
      return NextResponse.json({ error: 'Invalid review ID' }, { status: 400 });
    }

    const body = await request.json();
    const { message } = body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    const client = await createJudgemeClient();
    if (!client) {
      return NextResponse.json(
        { error: 'Judge.me integration not configured' },
        { status: 503 }
      );
    }

    const result = await client.replyToReview(reviewId, message.trim());

    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: result.message });
  } catch (err) {
    console.error('Error replying to review:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to reply' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'REPLY_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;
    const reviewId = parseInt(id, 10);

    if (isNaN(reviewId)) {
      return NextResponse.json({ error: 'Invalid review ID' }, { status: 400 });
    }

    const body = await request.json();
    const { message } = body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    const client = await createJudgemeClient();
    if (!client) {
      return NextResponse.json(
        { error: 'Judge.me integration not configured' },
        { status: 503 }
      );
    }

    const result = await client.updateReply(reviewId, message.trim());

    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: result.message });
  } catch (err) {
    console.error('Error updating review reply:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to update reply' },
      { status: 500 }
    );
  }
}
