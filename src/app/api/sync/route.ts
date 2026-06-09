/**
 * Email sync API - Trigger manual sync or get sync status
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { runEmailSync } from '@/lib/email/sync-service';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get recent sync jobs
    const jobs = await prisma.syncJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    // Get mailbox status
    const mailboxes = await prisma.mailbox.findMany({
      select: {
        id: true,
        displayName: true,
        emailAddress: true,
        lastSyncAt: true,
        syncError: true,
        active: true,
      },
    });

    return NextResponse.json({ jobs, mailboxes });
  } catch (err) {
    console.error('Error fetching sync status:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'MANAGE_INTEGRATIONS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const outcome = await runEmailSync();

    if (!outcome.success) {
      const status = outcome.error === 'Email integration not configured' ||
        outcome.error === 'Email provider not configured'
        ? 503
        : 500;
      return NextResponse.json(
        { error: 'Sync failed', details: outcome.error },
        { status }
      );
    }

    return NextResponse.json({
      success: true,
      skipped: outcome.skipped || false,
      messagesProcessed: outcome.messagesProcessed,
    });
  } catch (err) {
    console.error('Error syncing emails:', err);
    return NextResponse.json(
      { error: 'Sync failed', details: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
