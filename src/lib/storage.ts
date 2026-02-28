/**
 * Storage utilities for handling file storage paths
 * Works across different environments (local, Railway, etc.)
 */

import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * Get the base storage directory
 * Uses STORAGE_PATH env var, falls back to /app/storage or /tmp/storage
 */
export function getStorageDir(): string {
  // Allow override via environment variable
  if (process.env.STORAGE_PATH) {
    return process.env.STORAGE_PATH;
  }

  // In production (Railway), use /app/storage or /tmp as fallback
  if (process.env.NODE_ENV === 'production') {
    return '/app/storage';
  }

  // In development, use project directory
  return path.join(process.cwd(), 'storage');
}

/**
 * Get the attachments directory path
 */
export function getAttachmentsDir(): string {
  return path.join(getStorageDir(), 'attachments');
}

/**
 * Ensure the attachments directory exists
 * Creates it if needed, with fallback to /tmp if permission denied
 */
export async function ensureAttachmentsDir(): Promise<string> {
  const dir = getAttachmentsDir();

  try {
    await fs.mkdir(dir, { recursive: true });
    return dir;
  } catch (err) {
    // If permission denied, fall back to /tmp
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      const tmpDir = '/tmp/storage/attachments';
      console.warn(`[Storage] Permission denied for ${dir}, falling back to ${tmpDir}`);
      await fs.mkdir(tmpDir, { recursive: true });
      return tmpDir;
    }
    throw err;
  }
}
