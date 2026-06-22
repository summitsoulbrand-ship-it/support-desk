/**
 * Mark a Printify escalation done (or reopen it) from the Needs Attention tab.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';

type RouteContext = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  status: z.enum(['PENDING', 'DONE']).optional(),
  // Manual Printify-side mark (reprint created / Printify refunded us).
  printifyHandled: z.boolean().optional(),
  // We issued the refund/replacement ourselves (Printify declined).
  selfHandled: z.boolean().optional(),
  // Free-text operator note.
  note: z.string().max(2000).optional(),
  // Mark that the delay-update email was sent to the customer (via the tool).
  customerEmailed: z.boolean().optional(),
});

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!hasPermission(session.user.role, 'CHANGE_STATUS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;
    const { status, printifyHandled, selfHandled, note, customerEmailed } =
      patchSchema.parse(await request.json());
    const who = session.user.name || session.user.email || null;

    const data: Record<string, unknown> = {};
    if (status === 'DONE') {
      data.status = 'DONE';
      data.resolvedAt = new Date();
      data.resolvedBy = who;
    } else if (status === 'PENDING') {
      data.status = 'PENDING';
      data.resolvedAt = null;
      data.resolvedBy = null;
    }
    if (printifyHandled !== undefined) {
      data.printifyHandled = printifyHandled;
      data.printifyHandledAt = printifyHandled ? new Date() : null;
      data.printifyHandledBy = printifyHandled ? who : null;
      // "Printify did it" and "we did it ourselves" are mutually exclusive.
      if (printifyHandled) {
        data.selfHandled = false;
        data.selfHandledAt = null;
        data.selfHandledBy = null;
      }
    }
    if (selfHandled !== undefined) {
      data.selfHandled = selfHandled;
      data.selfHandledAt = selfHandled ? new Date() : null;
      data.selfHandledBy = selfHandled ? who : null;
      if (selfHandled) {
        data.printifyHandled = false;
        data.printifyHandledAt = null;
        data.printifyHandledBy = null;
      }
    }
    if (note !== undefined) {
      data.note = note.trim() || null;
    }
    if (customerEmailed !== undefined) {
      data.customerEmailedAt = customerEmailed ? new Date() : null;
      data.customerEmailedBy = customerEmailed ? who : null;
    }

    const escalation = await prisma.printifyEscalation.update({ where: { id }, data });

    return NextResponse.json({ success: true, escalation });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request', details: err.issues }, { status: 400 });
    }
    console.error('[escalations] PATCH error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
