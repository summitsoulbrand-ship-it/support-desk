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

    const headers: Record<string, string> = {
      'Content-Type': attachment.mimeType || 'application/octet-stream',
      'Cache-Control': 'private, max-age=3600',
    };

    if (isDownload) {
      headers['Content-Disposition'] = `attachment; filename="${attachment.filename}"`;
    } else if (attachment.mimeType?.startsWith('image/')) {
      headers['Content-Disposition'] = 'inline';
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
