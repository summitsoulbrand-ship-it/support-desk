/**
 * Track a late order's resolution fields: whether the customer was refunded,
 * whether Printify refunded us, and free-text notes. Resolution is DERIVED in
 * the late-orders GET route - an order is resolved only when the customer was
 * made whole (refund or replacement) AND the Printify decision is recorded.
 * Notes are informational and never resolve an order on their own.
 *
 * Each field is optional so the UI can patch one at a time. Pass null to clear
 * a yes/no field back to "not decided".
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { cacheDeletePattern } from '@/lib/cache';

const bodySchema = z.object({
  printifyOrderId: z.string().min(1),
  customerRefunded: z.boolean().nullable().optional(),
  refundedByPrintify: z.boolean().nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
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

  const resolvedBy = session.user.name || session.user.email || null;

  // Only touch the fields the request actually sent (patch semantics).
  const fields: {
    customerRefunded?: boolean | null;
    refundedByPrintify?: boolean | null;
    note?: string | null;
  } = {};
  if (body.customerRefunded !== undefined) fields.customerRefunded = body.customerRefunded;
  if (body.refundedByPrintify !== undefined) fields.refundedByPrintify = body.refundedByPrintify;
  if (body.note !== undefined) fields.note = body.note?.trim() || null;

  await prisma.lateOrderResolution.upsert({
    where: { printifyOrderId: body.printifyOrderId },
    create: { printifyOrderId: body.printifyOrderId, resolvedBy, ...fields },
    update: { resolvedBy, ...fields },
  });

  // The late-orders list is cached; clear it so the change shows on next load.
  await cacheDeletePattern('late-orders:v1:*');

  return NextResponse.json({ success: true });
}
