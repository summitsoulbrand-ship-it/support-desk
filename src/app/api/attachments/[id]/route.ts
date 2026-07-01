/**
 * Attachment download API (inline images)
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';

type RouteContext = {
  params: Promise<{ id: string }>;
};

// Only raster image types are safe to render inline in our origin. SVG can
// carry scripts and text/html would execute same-origin, so everything else is
// always forced to download. Inbound email attachments are attacker-controlled.
const INLINE_SAFE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// Script-capable types a browser may execute even from a download. Serve these
// as opaque bytes so they can never run in our origin.
const ACTIVE_CONTENT_TYPES = new Set([
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
]);

/**
 * Build an RFC 6266 / RFC 5987 safe Content-Disposition value. The email-supplied
 * filename is attacker-controlled: strip quotes, backslashes, and CR/LF (header
 * injection), keep an ASCII-only quoted fallback, and carry the full UTF-8 name
 * in the filename* form.
 */
function contentDisposition(
  type: 'inline' | 'attachment',
  filename: string
): string {
  const cleaned = (filename || 'attachment')
     
    .replace(/[\x00-\x1f\x7f"\\]/g, '_');
  const asciiFallback = cleaned.replace(/[^\x20-\x7e]/g, '_') || 'attachment';
  return `${type}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(cleaned)}`;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;
    const attachment = await prisma.attachment.findUnique({
      where: { id },
    });

    if (!attachment) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Prefer DB-stored bytes; fall back to the legacy local-disk path.
    let data: Buffer;
    if (attachment.content) {
      data = Buffer.from(attachment.content);
    } else if (attachment.storagePath) {
      try {
        data = await fs.readFile(attachment.storagePath);
      } catch {
        return NextResponse.json(
          { error: 'Attachment file is no longer available' },
          { status: 404 }
        );
      }
    } else {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Check if download is requested
    const url = new URL(_request.url);
    const isDownload = url.searchParams.has('download');

    const mimeType = (attachment.mimeType || 'application/octet-stream').toLowerCase();
    const headers: Record<string, string> = {
      // Never serve script-capable types (SVG, HTML, XML) with their real MIME
      // type - as opaque bytes they can't execute in our origin.
      'Content-Type': ACTIVE_CONTENT_TYPES.has(mimeType)
        ? 'application/octet-stream'
        : mimeType,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    };

    if (!isDownload && INLINE_SAFE_TYPES.has(mimeType)) {
      headers['Content-Disposition'] = contentDisposition('inline', attachment.filename);
    } else {
      // Everything that isn't a known-safe raster image is a forced download.
      headers['Content-Disposition'] = contentDisposition('attachment', attachment.filename);
    }

    return new NextResponse(new Uint8Array(data), { status: 200, headers });
  } catch (err) {
    console.error('Error serving attachment:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
