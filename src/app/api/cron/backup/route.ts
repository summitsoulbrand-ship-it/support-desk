/**
 * Automatic Daily Backup Cron Job
 *
 * Stores backups in the database for persistence on Railway/serverless platforms.
 *
 * This endpoint should be called once per day by:
 * - Vercel Cron (add to vercel.json)
 * - Railway Cron
 * - External cron service (e.g., cron-job.org)
 */

import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { gzipSync, gunzipSync } from 'zlib';
import prisma from '@/lib/db';

const execAsync = promisify(exec);

const MAX_BACKUPS = 7; // Keep last 7 backups

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
  for (const pgPath of PG_DUMP_PATHS) {
    try {
      await execAsync(`${pgPath} --version`);
      return pgPath;
    } catch {
      // Try next path
    }
  }
  throw new Error('pg_dump not found. Please install PostgreSQL client tools.');
}

// Shell escape function to prevent command injection
function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

// Parse DATABASE_URL to get connection details
function parseDbUrl(url: string) {
  // Try with password first
  let match = url.match(
    /^postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)$/
  );
  if (match) {
    return {
      user: match[1],
      password: match[2],
      host: match[3],
      port: match[4],
      database: match[5].split('?')[0],
    };
  }

  // Try without password (local dev with peer auth)
  match = url.match(/^postgresql:\/\/([^@]+)@([^:]+):(\d+)\/(.+)$/);
  if (match) {
    return {
      user: match[1],
      password: '',
      host: match[2],
      port: match[3],
      database: match[4].split('?')[0],
    };
  }

  throw new Error('Invalid DATABASE_URL format');
}

async function cleanupOldBackups() {
  try {
    // Get all backups ordered by date
    const backups = await prisma.databaseBackup.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, filename: true, createdAt: true },
    });

    // Delete old backups beyond MAX_BACKUPS
    const toDelete = backups.slice(MAX_BACKUPS);
    if (toDelete.length > 0) {
      await prisma.databaseBackup.deleteMany({
        where: { id: { in: toDelete.map(b => b.id) } },
      });
      console.log(`[Cron Backup] Deleted ${toDelete.length} old backup(s)`);
    }

    return toDelete.length;
  } catch (err) {
    console.error('[Cron Backup] Error cleaning up old backups:', err);
    return 0;
  }
}

export async function POST(request: NextRequest) {
  try {
    // Verify cron secret for security
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    const vercelCron = request.headers.get('x-vercel-cron');
    const isProduction = process.env.NODE_ENV === 'production';

    // In production, require either CRON_SECRET or Vercel cron header
    if (isProduction) {
      if (!vercelCron && (!cronSecret || authHeader !== `Bearer ${cronSecret}`)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    } else {
      // In development, allow if no CRON_SECRET is set (for convenience)
      if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
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
    // Exclude the database_backups table to avoid backing up backups
    const command = `${shellEscape(pgDump)} -h ${shellEscape(db.host)} -p ${shellEscape(db.port)} -U ${shellEscape(db.user)} -d ${shellEscape(db.database)} -F p --exclude-table=database_backups`;

    const { stdout } = await execAsync(command, { env, maxBuffer: 200 * 1024 * 1024 }); // 200MB buffer

    // Compress the backup
    const compressed = gzipSync(Buffer.from(stdout, 'utf-8'));
    const originalSize = Buffer.byteLength(stdout, 'utf-8');
    const compressedSize = compressed.length;

    // Store in database
    await prisma.databaseBackup.create({
      data: {
        filename,
        size: originalSize,
        data: compressed,
      },
    });

    // Clean up old backups
    const deletedCount = await cleanupOldBackups();

    console.log(`[Cron Backup] Created backup: ${filename} (${formatBytes(originalSize)} -> ${formatBytes(compressedSize)} compressed)`);

    return NextResponse.json({
      success: true,
      backup: {
        filename,
        size: originalSize,
        compressedSize,
        sizeFormatted: formatBytes(originalSize),
        compressedSizeFormatted: formatBytes(compressedSize),
        createdAt: new Date().toISOString(),
      },
      cleanedUp: deletedCount,
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

// Also support GET for Vercel Cron compatibility
export async function GET(request: NextRequest) {
  return POST(request);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Export gunzip for use in download route
export { gunzipSync };
