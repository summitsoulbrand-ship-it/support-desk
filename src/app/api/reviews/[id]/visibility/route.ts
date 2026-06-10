/**
 * Review visibility API - hide (curated: spam) or publish (curated: ok) a
 * Judge.me review from the tool, so the VA never needs the Judge.me admin.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import { createJudgemeClient } from '@/lib/judgeme/client';
import { markReviewHandled } from '@/lib/judgeme/review-drafts';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
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
    const action = body.action as string;
    if (action !== 'hide' && action !== 'publish') {
      return NextResponse.json(
        { error: "action must be 'hide' or 'publish'" },
        { status: 400 }
      );
    }

    const client = await createJudgemeClient();
    if (!client) {
      return NextResponse.json(
        { error: 'Judge.me integration not configured' },
        { status: 503 }
      );
    }

    const result = await client.setReviewCuration(
      reviewId,
      action === 'hide' ? 'spam' : 'ok'
    );

    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: 500 });
    }

    if (action === 'hide') {
      await markReviewHandled(reviewId);
    }

    return NextResponse.json({ success: true, message: result.message });
  } catch (err) {
    console.error('Error updating review visibility:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to update visibility' },
      { status: 500 }
    );
  }
}
