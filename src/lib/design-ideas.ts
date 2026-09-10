/**
 * Pull design ideas out of email threads tagged "Design", and write the
 * "we made the thing you asked for" note that closes the loop with them.
 *
 * When Pati (or an agent) tags an email thread "Design", the customer's
 * message is a design suggestion. This mirrors those threads into the
 * DesignIdea table so they show up alongside the social-comment ideas.
 * Idempotent: keyed on the thread id, so re-running never duplicates.
 */

import prisma from '@/lib/db';

export * from '@/lib/design-ideas-text';

const DESIGN_TAG = 'Design';

export async function syncEmailDesignIdeas(): Promise<number> {
  const threads = await prisma.thread.findMany({
    where: {
      tags: { some: { tag: { name: { equals: DESIGN_TAG, mode: 'insensitive' } } } },
    },
    select: {
      id: true,
      customerName: true,
      customerEmail: true,
      messages: {
        where: { direction: 'INBOUND' },
        orderBy: { sentAt: 'asc' },
        select: { bodyText: true, bodyHtml: true },
        take: 1, // the customer's original message carries the idea
      },
    },
    take: 500,
  });

  if (threads.length === 0) return 0;

  // Which of these already have an idea row?
  const existing = await prisma.designIdea.findMany({
    where: { source: 'EMAIL', sourceId: { in: threads.map((t) => t.id) } },
    select: { id: true, sourceId: true, customerEmail: true },
  });
  const have = new Map(existing.map((e) => [e.sourceId, e]));

  let created = 0;
  for (const t of threads) {
    const already = have.get(t.id);
    if (already) {
      // Rows written before ideas carried an address still have a thread to
      // read it off, so backfill rather than leaving them un-emailable.
      if (!already.customerEmail && t.customerEmail) {
        await prisma.designIdea.update({
          where: { id: already.id },
          data: { customerEmail: t.customerEmail },
        });
      }
      continue;
    }
    const msg = t.messages[0];
    const text = (
      msg?.bodyText ||
      msg?.bodyHtml?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ') ||
      ''
    ).trim();
    if (text.length < 2) continue; // nothing usable yet

    await prisma.designIdea.create({
      data: {
        text: text.slice(0, 4000),
        source: 'EMAIL',
        authorName: t.customerName || t.customerEmail,
        customerEmail: t.customerEmail,
        permalink: `/inbox?thread=${t.id}`,
        sourceId: t.id,
        threadId: t.id,
      },
    });
    created++;
  }

  return created;
}
