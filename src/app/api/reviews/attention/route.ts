/**
 * Reviews needing attention - low-star (<=3) unanswered reviews with their
 * pre-written AI reply drafts, ready for the VA to review and publish.
 */

import { NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const drafts = await prisma.reviewDraft.findMany({
      where: { status: { in: ['READY', 'PENDING', 'FAILED'] } },
      orderBy: { reviewCreatedAt: 'desc' },
      take: 100,
    });

    return NextResponse.json({ drafts });
  } catch (err) {
    console.error('Error fetching attention reviews:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
