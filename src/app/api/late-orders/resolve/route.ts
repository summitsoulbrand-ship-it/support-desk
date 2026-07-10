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
import { cacheDeletePattern, LATE_ORDERS_CACHE_PATTERN } from '@/lib/cache';

const bodySchema = z.object({
  printifyOrderId: z.string().min(1),
  customerRefunded: z.boolean().nullable().optional(),
  refundedByPrintify: z.boolean().nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
  // Mark that the delay-update email was sent to the customer (via the tool).
  delayEmailed: z.boolean().optional(),
  // Operator explicitly marks the order done/handled (true) or undoes it (false).
  // Only allowed once BOTH refund questions are answered - see the gate below.
  handled: z.boolean().optional(),
  // The customer-refunded side was answered by an AUTO signal the page detected
  // (Shopify refund, replacement, or Shopify's $0-refund default) rather than
  // the manual toggle - the server can't recompute those here, so the client
  // asserts it when marking handled.
  customerAutoAnswered: z.boolean().optional(),
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
    delayEmailedAt?: Date | null;
    delayEmailedBy?: string | null;
    handledAt?: Date | null;
    handledBy?: string | null;
  } = {};
  if (body.customerRefunded !== undefined) fields.customerRefunded = body.customerRefunded;
  if (body.refundedByPrintify !== undefined) fields.refundedByPrintify = body.refundedByPrintify;
  if (body.note !== undefined) fields.note = body.note?.trim() || null;
  if (body.delayEmailed !== undefined) {
    fields.delayEmailedAt = body.delayEmailed ? new Date() : null;
    fields.delayEmailedBy = body.delayEmailed ? resolvedBy : null;
  }
  if (body.handled !== undefined) {
    if (body.handled) {
      // Gate: mark-done requires BOTH refund questions answered - the Printify
      // decision (yes or no) and the customer side (manual toggle, or an auto
      // signal the client asserts via customerAutoAnswered).
      const existing = await prisma.lateOrderResolution.findUnique({
        where: { printifyOrderId: body.printifyOrderId },
        select: { customerRefunded: true, refundedByPrintify: true },
      });
      const customerAnswered =
        (body.customerRefunded !== undefined
          ? body.customerRefunded
          : existing?.customerRefunded ?? null) !== null ||
        body.customerAutoAnswered === true;
      const printifyAnswered =
        (body.refundedByPrintify !== undefined
          ? body.refundedByPrintify
          : existing?.refundedByPrintify ?? null) !== null;
      if (!customerAnswered || !printifyAnswered) {
        return NextResponse.json(
          {
            error:
              'Answer both "Customer refunded" and "Refunded by Printify" before marking this order done.',
          },
          { status: 400 }
        );
      }
    }
    fields.handledAt = body.handled ? new Date() : null;
    fields.handledBy = body.handled ? resolvedBy : null;
  }

  await prisma.lateOrderResolution.upsert({
    where: { printifyOrderId: body.printifyOrderId },
    create: { printifyOrderId: body.printifyOrderId, resolvedBy, ...fields },
    update: { resolvedBy, ...fields },
  });

  // The late-orders list is cached; clear it so the change shows on next load.
  await cacheDeletePattern(LATE_ORDERS_CACHE_PATTERN);

  return NextResponse.json({ success: true });
}
