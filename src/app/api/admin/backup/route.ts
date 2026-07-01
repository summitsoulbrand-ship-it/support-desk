/**
 * Database Backup API
 * Create and manage PostgreSQL backups stored in the database.
 * The actual dump logic lives in src/lib/backup.ts (shared with the
 * worker's daily db-backup loop). Backups are chunked across rows
 * sharing a filename - list/delete operate on part 0 / all parts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, isAdmin } from '@/lib/auth';
import prisma from '@/lib/db';
import { runDatabaseBackup, formatBytes } from '@/lib/backup';

// GET - List available backups from database
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user || !isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // One row per backup: part 0 represents the whole chunked backup
    const backups = await prisma.databaseBackup.findMany({
      where: { part: 0 },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        filename: true,
        size: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      backups: backups.map(b => ({
        id: b.id,
        filename: b.filename,
        size: b.size,
        sizeFormatted: formatBytes(b.size),
        createdAt: b.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('Error listing backups:', err);
    return NextResponse.json(
      { error: 'Failed to list backups' },
      { status: 500 }
    );
  }
}

// POST - Create a new backup and store in database
export async function POST() {
  try {
    const session = await getSession();
    if (!session?.user || !isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

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
    });
  } catch (err: unknown) {
    console.error('Error creating backup:', err);

    let details = 'Unknown error';
    if (err instanceof Error) {
      details = err.message;
      const execErr = err as Error & { stderr?: string };
      if (execErr.stderr) {
        details += ` | stderr: ${execErr.stderr}`;
      }
    }

    return NextResponse.json(
      {
        error: 'Failed to create backup',
        details,
      },
      { status: 500 }
    );
  }
}

// DELETE - Delete a backup from database (all chunks)
export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user || !isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { error: 'Backup ID is required' },
        { status: 400 }
      );
    }

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

    // Remove every chunk of this backup
    await prisma.databaseBackup.deleteMany({
      where: { filename: backup.filename },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error deleting backup:', err);
    return NextResponse.json(
      { error: 'Failed to delete backup' },
      { status: 500 }
    );
  }
}
