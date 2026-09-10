/**
 * One design idea: move it through the follow-up pipeline, or drop it.
 *
 * PATCH carries intent, not raw columns - attaching a product IS "we made it",
 * and recording a reply IS "the customer has been told" - so the dates that
 * drive the tabs can never drift out of step with the status.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getSession } from '@/lib/auth';
import { logAction } from '@/lib/audit';
import { z } from 'zod';

const patchSchema = z.object({
  status: z.enum(['OPEN', 'MADE', 'PASSED']).optional(),
  customerEmail: z.string().email().nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
  // The live product that answers the request; null unlinks it.
  product: z
    .object({
      handle: z.string().min(1),
      title: z.string().min(1),
      image: z.string().url().optional(),
    })
    .nullable()
    .optional(),
  // How the customer was told; null undoes it (told the wrong person, etc).
  notified: z
    .object({
      via: z.enum(['EMAIL', 'SOCIAL']),
      threadId: z.string().optional(),
    })
    .nullable()
    .optional(),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await context.params;
  const body = patchSchema.parse(await request.json());

  const before = await prisma.designIdea.findUnique({ where: { id } });
  if (!before) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const data: Record<string, unknown> = {};
  if (body.status) data.status = body.status;
  if (body.customerEmail !== undefined) data.customerEmail = body.customerEmail;
  if (body.note !== undefined) data.note = body.note;

  if (body.product !== undefined) {
    if (body.product) {
      data.productHandle = body.product.handle;
      data.productTitle = body.product.title;
      data.productImage = body.product.image ?? null;
      data.madeAt = before.madeAt ?? new Date();
      if (!body.status) data.status = 'MADE';
    } else {
      data.productHandle = null;
      data.productTitle = null;
      data.productImage = null;
      data.madeAt = null;
      // Unlinking the product takes it back to the to-make pile, unless this
      // same call is deliberately parking it.
      if (!body.status) data.status = 'OPEN';
    }
  }

  if (body.notified !== undefined) {
    if (body.notified) {
      data.notifiedAt = new Date();
      data.notifiedVia = body.notified.via;
      if (body.notified.threadId) data.threadId = body.notified.threadId;
    } else {
      data.notifiedAt = null;
      data.notifiedVia = null;
    }
  }

  const idea = await prisma.designIdea.update({ where: { id }, data });

  const who = {
    userId: session.user.id,
    userName: session.user.name || session.user.email || 'Agent',
  };
  if (body.product) {
    await logAction({
      ...who,
      action: 'design_idea_made',
      summary: `Linked design idea to "${body.product.title}"`,
    });
  }
  if (body.notified) {
    await logAction({
      ...who,
      threadId: body.notified.threadId ?? null,
      action: 'design_idea_notified',
      summary: `Told ${idea.authorName || 'the customer'} their design idea is live${
        idea.productTitle ? `: "${idea.productTitle}"` : ''
      }`,
    });
  }

  return NextResponse.json({ idea });
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await context.params;
  await prisma.designIdea.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
