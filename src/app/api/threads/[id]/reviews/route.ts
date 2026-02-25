/**
 * Thread Reviews API - Fetch Judge.me reviews for the customer
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { createJudgemeClient } from '@/lib/judgeme';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await params;

    // Get thread to find customer email
    const thread = await prisma.thread.findUnique({
      where: { id },
      select: { customerEmail: true },
    });

    if (!thread) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    }

    // Get Judge.me client
    const judgemeClient = await createJudgemeClient();
    if (!judgemeClient) {
      return NextResponse.json(
        { error: 'Judge.me integration not configured', reviews: [] },
        { status: 200 }
      );
    }

    // Fetch reviews for this customer
    const page = parseInt(request.nextUrl.searchParams.get('page') || '1');
    const perPage = parseInt(request.nextUrl.searchParams.get('perPage') || '10');

    const result = await judgemeClient.getReviewsByEmail(
      thread.customerEmail,
      page,
      perPage
    );

    return NextResponse.json(result);
  } catch (err) {
    console.error('Error fetching reviews:', err);
    return NextResponse.json(
      { error: 'Failed to fetch reviews', reviews: [] },
      { status: 500 }
    );
  }
}
