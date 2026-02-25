/**
 * Reviews API - Fetch product reviews from Judge.me
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createJudgemeClient } from '@/lib/judgeme/client';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1', 10);
    const perPage = parseInt(searchParams.get('perPage') || '20', 10);
    const email = searchParams.get('email');
    const rating = searchParams.get('rating');
    const ratingFilter = rating ? parseInt(rating, 10) : undefined;

    const client = await createJudgemeClient();
    if (!client) {
      return NextResponse.json(
        { error: 'Judge.me integration not configured' },
        { status: 503 }
      );
    }

    let result;
    if (email) {
      // Search by customer email
      result = await client.getReviewsByEmail(email, page, perPage, ratingFilter);
    } else {
      // Get recent reviews
      result = await client.getRecentReviews(page, perPage, ratingFilter);
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error('Error fetching reviews:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch reviews' },
      { status: 500 }
    );
  }
}
