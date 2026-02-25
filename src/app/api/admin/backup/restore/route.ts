/**
 * Database Restore API
 * Restore from a backup file
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, isAdmin } from '@/lib/auth';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

const BACKUP_DIR = path.join(process.cwd(), 'backups');

// Common PostgreSQL tool locations
const PG_PATHS = [
  '', // In PATH (no prefix needed)
  '/opt/homebrew/opt/postgresql@16/bin/',
  '/opt/homebrew/opt/postgresql@15/bin/',
  '/opt/homebrew/opt/postgresql@14/bin/',
  '/opt/homebrew/bin/',
  '/usr/local/bin/',
  '/usr/bin/',
];

async function findPgTool(tool: string): Promise<string> {
  for (const prefix of PG_PATHS) {
    const fullPath = `${prefix}${tool}`;
    try {
      await execAsync(`"${fullPath}" --version`);
      return fullPath;
    } catch {
      // Try next path
    }
  }
  throw new Error(`${tool} not found. Please install PostgreSQL client tools.`);
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

// POST - Restore from a backup
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user || !isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { filename } = body;

    if (!filename) {
      return NextResponse.json(
        { error: 'Filename is required' },
        { status: 400 }
      );
    }

    // Validate filename to prevent path traversal
    if (filename.includes('/') || filename.includes('..')) {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
    }

    const filepath = path.join(BACKUP_DIR, filename);

    // Check if file exists
    try {
      await fs.access(filepath);
    } catch {
      return NextResponse.json(
        { error: 'Backup file not found' },
        { status: 404 }
      );
    }

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      return NextResponse.json(
        { error: 'DATABASE_URL not configured' },
        { status: 500 }
      );
    }

    const db = parseDbUrl(dbUrl);
    const env = { ...process.env, PGPASSWORD: db.password };

    // Find PostgreSQL tools
    const pgDump = await findPgTool('pg_dump');
    const psql = await findPgTool('psql');

    // First, create a pre-restore backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const preRestoreBackup = `pre-restore-${timestamp}.sql`;
    const preRestorePath = path.join(BACKUP_DIR, preRestoreBackup);

    try {
      const backupCommand = `"${pgDump}" -h ${db.host} -p ${db.port} -U ${db.user} -d ${db.database} -F p -f "${preRestorePath}"`;
      await execAsync(backupCommand, { env });
    } catch (backupErr) {
      console.error('Failed to create pre-restore backup:', backupErr);
      // Continue with restore anyway
    }

    // Drop and recreate the database schema
    // Using psql to run the restore
    const restoreCommand = `"${psql}" -h ${db.host} -p ${db.port} -U ${db.user} -d ${db.database} -f "${filepath}"`;

    try {
      // First, drop all tables (to handle schema changes)
      const dropCommand = `"${psql}" -h ${db.host} -p ${db.port} -U ${db.user} -d ${db.database} -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`;
      await execAsync(dropCommand, { env });

      // Then restore
      await execAsync(restoreCommand, { env });
    } catch (restoreErr) {
      console.error('Restore command failed:', restoreErr);
      return NextResponse.json(
        {
          error: 'Restore failed',
          details: restoreErr instanceof Error ? restoreErr.message : 'Unknown error',
          preRestoreBackup,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: `Database restored from ${filename}`,
      preRestoreBackup,
    });
  } catch (err) {
    console.error('Error restoring backup:', err);
    return NextResponse.json(
      {
        error: 'Failed to restore backup',
        details: err instanceof Error ? err.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
