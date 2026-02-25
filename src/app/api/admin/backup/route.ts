/**
 * Database Backup API
 * Create and restore PostgreSQL backups
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, isAdmin } from '@/lib/auth';
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

// GET - List available backups
export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user || !isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Ensure backup directory exists
    await fs.mkdir(BACKUP_DIR, { recursive: true });

    // List backup files
    const files = await fs.readdir(BACKUP_DIR);
    const backups = await Promise.all(
      files
        .filter((f) => f.endsWith('.sql') || f.endsWith('.sql.gz'))
        .map(async (filename) => {
          const filepath = path.join(BACKUP_DIR, filename);
          const stats = await fs.stat(filepath);
          return {
            filename,
            size: stats.size,
            createdAt: stats.birthtime.toISOString(),
            sizeFormatted: formatBytes(stats.size),
          };
        })
    );

    // Sort by date, newest first
    backups.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return NextResponse.json({ backups });
  } catch (err) {
    console.error('Error listing backups:', err);
    return NextResponse.json(
      { error: 'Failed to list backups' },
      { status: 500 }
    );
  }
}

// POST - Create a new backup
export async function POST(request: NextRequest) {
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

    // Ensure backup directory exists
    await fs.mkdir(BACKUP_DIR, { recursive: true });

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${timestamp}.sql`;
    const filepath = path.join(BACKUP_DIR, filename);

    // Find pg_dump and run it
    const pgDump = await findPgDump();
    const env = { ...process.env, PGPASSWORD: db.password };
    // Use shell escaping to prevent command injection
    const command = `${shellEscape(pgDump)} -h ${shellEscape(db.host)} -p ${shellEscape(db.port)} -U ${shellEscape(db.user)} -d ${shellEscape(db.database)} -F p -f ${shellEscape(filepath)}`;

    await execAsync(command, { env });

    // Get file size
    const stats = await fs.stat(filepath);

    return NextResponse.json({
      success: true,
      backup: {
        filename,
        size: stats.size,
        sizeFormatted: formatBytes(stats.size),
        createdAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('Error creating backup:', err);
    return NextResponse.json(
      {
        error: 'Failed to create backup',
        details: err instanceof Error ? err.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

// DELETE - Delete a backup file
export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user || !isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const filename = searchParams.get('filename');

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

    await fs.unlink(filepath);

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
