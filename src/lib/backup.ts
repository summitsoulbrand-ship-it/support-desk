/**
 * Database backup service
 *
 * Dumps the Postgres database with pg_dump, gzips it, and stores it in the
 * database_backups table (persistent on Railway, unlike the ephemeral
 * filesystem). Keeps the last MAX_BACKUPS backups.
 *
 * Called by:
 *  - the worker's daily db-backup loop (src/workers/main.ts) - the primary path
 *  - the /api/cron/backup route (manual trigger / external cron with CRON_SECRET)
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { gzipSync } from 'zlib';
import prisma from '@/lib/db';

const execAsync = promisify(exec);

const MAX_BACKUPS = 3; // Keep last 3 backups

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

export interface BackupResult {
  filename: string;
  size: number;
  compressedSize: number;
  sizeFormatted: string;
  compressedSizeFormatted: string;
  createdAt: Date;
  /** How many old backups were deleted to enforce MAX_BACKUPS */
  cleanedUp: number;
}

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

async function cleanupOldBackups(): Promise<number> {
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
      console.log(`[Backup] Deleted ${toDelete.length} old backup(s)`);
    }

    return toDelete.length;
  } catch (err) {
    console.error('[Backup] Error cleaning up old backups:', err);
    return 0;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/** When the newest stored backup was created, or null if none exist */
export async function latestBackupAt(): Promise<Date | null> {
  const newest = await prisma.databaseBackup.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return newest?.createdAt ?? null;
}

/**
 * Run a full database backup: pg_dump -> gzip -> database_backups row,
 * then prune old backups beyond MAX_BACKUPS. Throws on failure.
 */
export async function runDatabaseBackup(): Promise<BackupResult> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL not configured');
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
  const record = await prisma.databaseBackup.create({
    data: {
      filename,
      size: originalSize,
      data: compressed,
    },
  });

  // Clean up old backups
  const cleanedUp = await cleanupOldBackups();

  console.log(
    `[Backup] Created backup: ${filename} (${formatBytes(originalSize)} -> ${formatBytes(compressedSize)} compressed)`
  );

  return {
    filename,
    size: originalSize,
    compressedSize,
    sizeFormatted: formatBytes(originalSize),
    compressedSizeFormatted: formatBytes(compressedSize),
    createdAt: record.createdAt,
    cleanedUp,
  };
}
