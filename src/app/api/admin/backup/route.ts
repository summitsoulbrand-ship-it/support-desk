/**
 * Database Backup API
 * Create and manage PostgreSQL backups stored in the database
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, isAdmin } from '@/lib/auth';
import { exec } from 'child_process';
import { promisify } from 'util';
import { gzipSync } from 'zlib';
import prisma from '@/lib/db';

const execAsync = promisify(exec);

// Shell escape function to prevent command injection
function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

// Common pg_dump locations (including Docker Alpine paths)
const PG_DUMP_PATHS = [
  'pg_dump', // In PATH
  '/usr/bin/pg_dump', // Alpine Linux / Docker
  '/usr/local/bin/pg_dump',
  '/opt/homebrew/opt/postgresql@16/bin/pg_dump',
  '/opt/homebrew/opt/postgresql@15/bin/pg_dump',
  '/opt/homebrew/opt/postgresql@14/bin/pg_dump',
  '/opt/homebrew/bin/pg_dump',
];

async function findPgDump(): Promise<string> {
  const errors: string[] = [];
  for (const pgPath of PG_DUMP_PATHS) {
    try {
      const { stdout } = await execAsync(`${pgPath} --version`);
      console.log(`Found pg_dump at ${pgPath}: ${stdout.trim()}`);
      return pgPath;
    } catch (e) {
      errors.push(`${pgPath}: ${e instanceof Error ? e.message : 'not found'}`);
    }
  }
  throw new Error(`pg_dump not found. Tried: ${errors.join(', ')}`);
}

// Parse DATABASE_URL to get connection details using URL API for robustness
function parseDbUrl(url: string) {
  try {
    const normalizedUrl = url.replace(/^postgresql:\/\//, 'postgres://');
    const parsed = new URL(normalizedUrl);

    return {
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      host: parsed.hostname,
      port: parsed.port || '5432',
      database: parsed.pathname.slice(1),
    };
  } catch (e) {
    throw new Error(`Invalid DATABASE_URL format: ${e instanceof Error ? e.message : 'Unknown error'}`);
  }
}

// GET - List available backups from database
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user || !isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // List backups from database (without the actual data)
    const backups = await prisma.databaseBackup.findMany({
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

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      return NextResponse.json(
        { error: 'DATABASE_URL not configured' },
        { status: 500 }
      );
    }

    const db = parseDbUrl(dbUrl);

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${timestamp}.sql.gz`;

    // Find pg_dump and run it (output to stdout)
    const pgDump = await findPgDump();
    const env = { ...process.env, PGPASSWORD: db.password };

    const args = [
      '-h', shellEscape(db.host),
      '-p', shellEscape(db.port),
      '-U', shellEscape(db.user),
      '-d', shellEscape(db.database),
      '-F', 'p',
      '--exclude-table=database_backups', // Don't backup backups
    ].join(' ');

    const command = `${pgDump} ${args}`;
    console.log('Running pg_dump command:', command.replace(db.password, '***'));

    const { stdout, stderr } = await execAsync(command, {
      env,
      maxBuffer: 200 * 1024 * 1024 // 200MB buffer
    });

    if (stderr) {
      console.log('pg_dump stderr:', stderr);
    }

    // Compress the backup
    const compressed = gzipSync(Buffer.from(stdout, 'utf-8'));
    const originalSize = Buffer.byteLength(stdout, 'utf-8');
    const compressedSize = compressed.length;

    // Store in database
    const backup = await prisma.databaseBackup.create({
      data: {
        filename,
        size: originalSize,
        data: compressed,
      },
    });

    console.log(`[Backup] Created: ${filename} (${formatBytes(originalSize)} -> ${formatBytes(compressedSize)} compressed)`);

    // Clean up old backups, keep only the last 3
    const allBackups = await prisma.databaseBackup.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    if (allBackups.length > 3) {
      const backupsToDelete = allBackups.slice(3);
      await prisma.databaseBackup.deleteMany({
        where: {
          id: { in: backupsToDelete.map(b => b.id) },
        },
      });
      console.log(`[Backup] Cleaned up ${backupsToDelete.length} old backup(s)`);
    }

    return NextResponse.json({
      success: true,
      backup: {
        id: backup.id,
        filename,
        size: originalSize,
        compressedSize,
        sizeFormatted: formatBytes(originalSize),
        compressedSizeFormatted: formatBytes(compressedSize),
        createdAt: backup.createdAt.toISOString(),
      },
    });
  } catch (err: unknown) {
    console.error('Error creating backup:', err);

    let details = 'Unknown error';
    if (err instanceof Error) {
      details = err.message;
      const execErr = err as Error & { stderr?: string; stdout?: string };
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

// DELETE - Delete a backup from database
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

    // Check if backup exists
    const backup = await prisma.databaseBackup.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!backup) {
      return NextResponse.json(
        { error: 'Backup not found' },
        { status: 404 }
      );
    }

    await prisma.databaseBackup.delete({
      where: { id },
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
