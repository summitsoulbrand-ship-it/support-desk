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
    // Handle postgres:// and postgresql:// schemes
    const normalizedUrl = url.replace(/^postgresql:\/\//, 'postgres://');
    const parsed = new URL(normalizedUrl);

    return {
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      host: parsed.hostname,
      port: parsed.port || '5432',
      database: parsed.pathname.slice(1), // Remove leading /
    };
  } catch (e) {
    throw new Error(`Invalid DATABASE_URL format: ${e instanceof Error ? e.message : 'Unknown error'}`);
  }
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

    // Build command with proper escaping (don't escape the command itself)
    const args = [
      '-h', shellEscape(db.host),
      '-p', shellEscape(db.port),
      '-U', shellEscape(db.user),
      '-d', shellEscape(db.database),
      '-F', 'p',
      '-f', shellEscape(filepath),
    ].join(' ');

    const command = `${pgDump} ${args}`;
    console.log('Running pg_dump command:', command.replace(db.password, '***'));

    const { stderr } = await execAsync(command, { env });
    if (stderr) {
      console.log('pg_dump stderr:', stderr);
    }

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
  } catch (err: unknown) {
    console.error('Error creating backup:', err);

    // Extract more details from exec errors
    let details = 'Unknown error';
    if (err instanceof Error) {
      details = err.message;
      // exec errors include stdout/stderr
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
