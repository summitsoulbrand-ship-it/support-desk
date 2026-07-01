/**
 * Download or delete a specific backup from the database.
 * Backups are chunked across rows sharing a filename; the id addresses any
 * part (the list UI hands out part 0) and operations cover all parts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, isAdmin } from '@/lib/auth';
import prisma from '@/lib/db';

type RouteParams = { params: Promise<{ id: string }> };

// GET - Download a backup (served compressed, as stored: .sql.gz)
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user || !isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    const backup = await prisma.databaseBackup.findUnique({
      where: { id },
      select: { filename: true },
    });

    if (!backup) {
      return NextResponse.json(
        { error: 'Backup not found' },
        { status: 404 }
      );
    }

    // Reassemble the gzip stream from its chunks. Served compressed - the
    // decompressed dump can be too large to hold in memory, and .sql.gz
    // opens with any standard tool.
    const parts = await prisma.databaseBackup.findMany({
      where: { filename: backup.filename },
      orderBy: { part: 'asc' },
      select: { data: true },
    });
    const compressed = Buffer.concat(parts.map((p) => Buffer.from(p.data)));

    return new NextResponse(compressed, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${backup.filename}"`,
        'Content-Length': compressed.length.toString(),
        'X-Content-Type-Options': 'nosniff',
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

    const backup = await prisma.databaseBackup.findUnique({
      where: { id },
      select: { filename: true },
    });

    if (!backup) {
      return NextResponse.json(
        { error: 'Backup not found' },
        { status: 404 }
      );
    }

    // Delete every chunk of this backup from database_backups
    await prisma.databaseBackup.deleteMany({
      where: { filename: backup.filename },
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
