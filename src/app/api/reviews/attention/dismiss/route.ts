/**
 * Dismiss a review from the needs-attention queue without replying or hiding
 * (e.g. handled directly in Judge.me, or no reply needed).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession, hasPermission } from '@/lib/auth';
import { markReviewHandled } from '@/lib/judgeme/review-drafts';

const bodySchema = z.object({ reviewId: z.number().int() });

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!hasPermission(session.user.role, 'REPLY_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { reviewId } = bodySchema.parse(await request.json());
    await markReviewHandled(reviewId);

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    console.error('Error dismissing review:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
