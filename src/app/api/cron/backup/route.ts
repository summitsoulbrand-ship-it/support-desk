/**
 * Manual / external backup trigger
 *
 * The primary backup path is the worker's daily db-backup loop
 * (src/workers/main.ts) - this endpoint exists for manual triggers and
 * external cron services (e.g. cron-job.org), and requires CRON_SECRET.
 *
 * Backup logic lives in src/lib/backup.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runDatabaseBackup } from '@/lib/backup';

export async function POST(request: NextRequest) {
  // Auth: require the CRON_SECRET bearer token unconditionally. There is no
  // header-based escape hatch (the old x-vercel-cron check was spoofable by
  // anyone, and we run on Railway anyway). Fail closed in production when the
  // secret is not configured; in development an unset secret allows the call
  // for convenience.
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { error: 'CRON_SECRET not configured' },
        { status: 503 }
      );
    }
  } else if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runDatabaseBackup();

    return NextResponse.json({
      success: true,
      backup: {
        filename: result.filename,
        size: result.size,
        compressedSize: result.compressedSize,
        sizeFormatted: result.sizeFormatted,
        compressedSizeFormatted: result.compressedSizeFormatted,
        createdAt: result.createdAt.toISOString(),
      },
      cleanedUp: result.cleanedUp,
    });
  } catch (err) {
    console.error('[Cron Backup] Error:', err);
    return NextResponse.json(
      {
        error: 'Failed to create backup',
        details: err instanceof Error ? err.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

// Also support GET for external cron services that can only issue GETs
export async function GET(request: NextRequest) {
  return POST(request);
}
