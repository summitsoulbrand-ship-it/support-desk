/**
 * Download a specific backup from the database
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, isAdmin } from '@/lib/auth';
import { gunzipSync } from 'zlib';
import prisma from '@/lib/db';

// GET - Download a backup
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession();
    if (!session?.user || !isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    const backup = await prisma.databaseBackup.findUnique({
      where: { id },
    });

    if (!backup) {
      return NextResponse.json(
        { error: 'Backup not found' },
        { status: 404 }
      );
    }

    // Decompress the backup
    const decompressed = gunzipSync(backup.data);

    // Return as downloadable SQL file
    const filename = backup.filename.replace('.gz', '');
    return new NextResponse(decompressed, {
      headers: {
        'Content-Type': 'application/sql',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': decompressed.length.toString(),
      },
    });
  } catch (err) {
    console.error('Error downloading backup:', err);
    return NextResponse.json(
      { error: 'Failed to download backup' },
      { status: 500 }
    );
  }
}
