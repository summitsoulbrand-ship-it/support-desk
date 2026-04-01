/**
 * Download or delete a specific backup from the database
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, isAdmin } from '@/lib/auth';
import { gunzipSync } from 'zlib';
import prisma from '@/lib/db';

type RouteParams = { params: Promise<{ id: string }> };

// GET - Download a backup
export async function GET(request: NextRequest, { params }: RouteParams) {
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

// DELETE - Delete a backup (only removes the backup record, not actual database data)
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user || !isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    // Verify the backup exists
    const backup = await prisma.databaseBackup.findUnique({
      where: { id },
    });

    if (!backup) {
      return NextResponse.json(
        { error: 'Backup not found' },
        { status: 404 }
      );
    }

    // Delete only the backup record from database_backups table
    await prisma.databaseBackup.delete({
      where: { id },
    });

    return NextResponse.json({ success: true, message: 'Backup deleted' });
  } catch (err) {
    console.error('Error deleting backup:', err);
    return NextResponse.json(
      { error: 'Failed to delete backup' },
      { status: 500 }
    );
  }
}
