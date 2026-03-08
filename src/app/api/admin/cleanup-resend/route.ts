/**
 * One-time cleanup endpoint to remove old RESEND integration record
 * DELETE after running once
 */

import { NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';

export async function POST() {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'MANAGE_INTEGRATIONS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Delete the RESEND record using raw SQL since it's no longer in the enum
    const result = await prisma.$executeRaw`DELETE FROM "IntegrationSettings" WHERE type = 'RESEND'`;

    return NextResponse.json({
      success: true,
      message: `Deleted ${result} RESEND record(s)`
    });
  } catch (err) {
    console.error('Error cleaning up RESEND:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
