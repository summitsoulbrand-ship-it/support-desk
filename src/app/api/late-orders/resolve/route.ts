/**
 * Manually mark a late order solved (or reopen it), with an optional note.
 * Used for resolutions we can't auto-detect - e.g. Printify refunded it, or it
 * was handled outside the system. Moves the order to the Solved tab.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { cacheDeletePattern } from '@/lib/cache';

const bodySchema = z.object({
  printifyOrderId: z.string().min(1),
  solved: z.boolean(),
  note: z.string().max(2000).optional(),
});

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasPermission(session.user.role, 'REPLY_THREADS')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const note = body.note?.trim() || null;
  const resolvedBy = session.user.name || session.user.email || null;

  await prisma.lateOrderResolution.upsert({
    where: { printifyOrderId: body.printifyOrderId },
    create: {
      printifyOrderId: body.printifyOrderId,
      solved: body.solved,
      note,
      resolvedBy,
    },
    update: { solved: body.solved, note, resolvedBy },
  });

  // The late-orders list is cached; clear it so the change shows on next load.
  await cacheDeletePattern('late-orders:v1:*');

  return NextResponse.json({ success: true });
}
