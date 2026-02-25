/**
 * Social Accounts API
 * Manage connected Facebook/Instagram accounts
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { z } from 'zod';

const updateAccountSchema = z.object({
  enabled: z.boolean().optional(),
  webhookEnabled: z.boolean().optional(),
});

/**
 * GET - List all social accounts
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accounts = await prisma.socialAccount.findMany({
      orderBy: [{ platform: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        platform: true,
        accountType: true,
        externalId: true,
        name: true,
        username: true,
        profilePictureUrl: true,
        webhookEnabled: true,
        enabled: true,
        lastSyncAt: true,
        syncError: true,
        createdAt: true,
        _count: {
          select: {
            comments: {
              where: { deleted: false },
            },
            objects: true,
          },
        },
      },
    });

    const formattedAccounts = accounts.map((account) => ({
      ...account,
      commentCount: account._count.comments,
      objectCount: account._count.objects,
      _count: undefined,
    }));

    return NextResponse.json({ accounts: formattedAccounts });
  } catch (err) {
    console.error('Error fetching social accounts:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * PATCH - Update account settings
 */
export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'MANAGE_INTEGRATIONS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const { accountId, ...data } = body;

    if (!accountId) {
      return NextResponse.json(
        { error: 'accountId is required' },
        { status: 400 }
      );
    }

    const validated = updateAccountSchema.parse(data);

    const account = await prisma.socialAccount.findUnique({
      where: { id: accountId },
    });

    if (!account) {
      return NextResponse.json(
        { error: 'Account not found' },
        { status: 404 }
      );
    }

    const updated = await prisma.socialAccount.update({
      where: { id: accountId },
      data: validated,
    });

    return NextResponse.json({ success: true, account: updated });
  } catch (err) {
    console.error('Error updating social account:', err);
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request', details: err.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
