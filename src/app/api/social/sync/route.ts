/**
 * Social Comments Sync API
 * Trigger manual sync of comments from Meta
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { syncSocialAccount, syncAllSocialAccounts } from '@/lib/social/sync';

/**
 * GET - Get sync status for all accounts
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get sync status for all accounts
    const accounts = await prisma.socialAccount.findMany({
      where: { enabled: true },
      select: {
        id: true,
        name: true,
        platform: true,
        lastSyncAt: true,
        syncError: true,
      },
    });

    // Get recent sync jobs
    const recentJobs = await prisma.socialSyncJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        accountId: true,
        status: true,
        startedAt: true,
        completedAt: true,
        commentsProcessed: true,
        newComments: true,
        errorMessage: true,
      },
    });

    // Get comment stats
    const commentStats = await prisma.socialComment.groupBy({
      by: ['status'],
      _count: { id: true },
      where: { deleted: false },
    });

    const stats = {
      new: 0,
      inProgress: 0,
      done: 0,
      escalated: 0,
    };

    for (const stat of commentStats) {
      switch (stat.status) {
        case 'NEW':
          stats.new = stat._count.id;
          break;
        case 'IN_PROGRESS':
          stats.inProgress = stat._count.id;
          break;
        case 'DONE':
          stats.done = stat._count.id;
          break;
        case 'ESCALATED':
          stats.escalated = stat._count.id;
          break;
      }
    }

    return NextResponse.json({
      accounts,
      recentJobs,
      stats,
    });
  } catch (err) {
    console.error('Error fetching sync status:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * POST - Trigger a sync or debug action
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Anyone can trigger sync (read-only operation)

    const body = await request.json().catch(() => ({}));
    const { accountId, action } = body;

    // Debug action: Check Meta permissions
    if (action === 'debug-permissions') {
      const { createMetaClient } = await import('@/lib/social/meta-client');

      // Find a Facebook account to use for debugging
      const account = await prisma.socialAccount.findFirst({
        where: { platform: 'FACEBOOK', enabled: true },
      });

      if (!account) {
        return NextResponse.json({ error: 'No Facebook account found' }, { status: 404 });
      }

      const client = await createMetaClient(account.externalId, true);
      if (!client) {
        return NextResponse.json({ error: 'Could not create Meta client' }, { status: 500 });
      }

      // Check user token permissions
      const userPerms = await client.debugTokenPermissions();

      // Check page token info
      const pageInfo = await client.debugPageTokenInfo();

      return NextResponse.json({
        success: true,
        accountName: account.name,
        pageId: account.externalId,
        userTokenPermissions: userPerms.permissions,
        pageTokenInfo: pageInfo,
        requiredPermissions: [
          'pages_show_list',
          'pages_read_engagement',
          'pages_read_user_content',  // This is needed for the 'from' field
          'pages_manage_engagement',
        ],
      });
    }

    if (accountId) {
      // Sync specific account
      const stats = await syncSocialAccount(accountId);
      return NextResponse.json({
        success: true,
        accountId,
        stats,
      });
    } else {
      // Sync all accounts
      const results = await syncAllSocialAccounts();
      const allStats = Object.fromEntries(results);

      return NextResponse.json({
        success: true,
        results: allStats,
      });
    }
  } catch (err) {
    console.error('Error syncing social comments:', err);
    return NextResponse.json(
      { error: 'Sync failed', details: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
