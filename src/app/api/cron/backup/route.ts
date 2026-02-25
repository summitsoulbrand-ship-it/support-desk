/**
 * Automatic Daily Backup Cron Job
 *
 * This endpoint should be called once per day by:
 * - Vercel Cron (add to vercel.json)
 * - System cron: curl -X POST http://localhost:3000/api/cron/backup -H "Authorization: Bearer $CRON_SECRET"
 * - External cron service
 */

import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

const BACKUP_DIR = path.join(process.cwd(), 'backups');

// Shell escape function to prevent command injection
function shellEscape(str: string): string {
  // Replace single quotes with escaped version and wrap in single quotes
  return `'${str.replace(/'/g, "'\\''")}'`;
}
const MAX_BACKUPS = 7; // Keep last 7 days of backups

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
    const files = await fs.readdir(BACKUP_DIR);
    const backupFiles = files
      .filter((f) => f.startsWith('auto-backup-') && f.endsWith('.sql'))
      .map((filename) => ({
        filename,
        path: path.join(BACKUP_DIR, filename),
      }));

    // Get file stats and sort by creation time
    const backupsWithStats = await Promise.all(
      backupFiles.map(async (backup) => {
        const stats = await fs.stat(backup.path);
        return { ...backup, createdAt: stats.birthtime };
      })
    );

    backupsWithStats.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Delete old backups beyond MAX_BACKUPS
    const toDelete = backupsWithStats.slice(MAX_BACKUPS);
    for (const backup of toDelete) {
      await fs.unlink(backup.path);
      console.log(`[Cron Backup] Deleted old backup: ${backup.filename}`);
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

    // Ensure backup directory exists
    await fs.mkdir(BACKUP_DIR, { recursive: true });

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `auto-backup-${timestamp}.sql`;
    const filepath = path.join(BACKUP_DIR, filename);

    // Find pg_dump and run it
    const pgDump = await findPgDump();
    const env = { ...process.env, PGPASSWORD: db.password };
    // Use shell escaping to prevent command injection
    const command = `${shellEscape(pgDump)} -h ${shellEscape(db.host)} -p ${shellEscape(db.port)} -U ${shellEscape(db.user)} -d ${shellEscape(db.database)} -F p -f ${shellEscape(filepath)}`;

    await execAsync(command, { env });

    // Get file size
    const stats = await fs.stat(filepath);

    // Clean up old backups
    const deletedCount = await cleanupOldBackups();

    console.log(`[Cron Backup] Created backup: ${filename} (${formatBytes(stats.size)})`);

    return NextResponse.json({
      success: true,
      backup: {
        filename,
        size: stats.size,
        sizeFormatted: formatBytes(stats.size),
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
