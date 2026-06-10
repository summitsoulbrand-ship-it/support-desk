/**
 * Knowledge sync endpoint
 * Receives brand voice / customer avatar (and any custom knowledge) pushed
 * from the Summit Soul AI project and upserts it as KnowledgeSource rows.
 * Authenticated with a bearer token (KNOWLEDGE_SYNC_TOKEN).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';

const sourceSchema = z.object({
  type: z.enum(['BRAND', 'AVATAR', 'CUSTOM']),
  key: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  source: z.string().optional(),
  enabled: z.boolean().optional(),
});

const bodySchema = z.object({
  sources: z.array(sourceSchema).min(1),
});

export async function POST(request: NextRequest) {
  const token = process.env.KNOWLEDGE_SYNC_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: 'Knowledge sync is not enabled (KNOWLEDGE_SYNC_TOKEN unset)' },
      { status: 503 }
    );
  }

  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { sources } = bodySchema.parse(await request.json());

    let upserted = 0;
    for (const s of sources) {
      await prisma.knowledgeSource.upsert({
        where: { key: s.key },
        create: {
          type: s.type,
          key: s.key,
          title: s.title,
          content: s.content,
          source: s.source,
          enabled: s.enabled ?? true,
        },
        update: {
          type: s.type,
          title: s.title,
          content: s.content,
          source: s.source,
          ...(s.enabled !== undefined ? { enabled: s.enabled } : {}),
        },
      });
      upserted++;
    }

    return NextResponse.json({ success: true, upserted });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request', details: err.issues },
        { status: 400 }
      );
    }
    console.error('Knowledge sync error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
}
