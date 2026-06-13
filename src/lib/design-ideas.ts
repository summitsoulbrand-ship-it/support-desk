/**
 * Pull design ideas out of email threads tagged "Design".
 *
 * When Pati (or an agent) tags an email thread "Design", the customer's
 * message is a design suggestion. This mirrors those threads into the
 * DesignIdea table so they show up alongside the social-comment ideas.
 * Idempotent: keyed on the thread id, so re-running never duplicates.
 */

import prisma from '@/lib/db';

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
    select: { sourceId: true },
  });
  const have = new Set(existing.map((e) => e.sourceId));

  let created = 0;
  for (const t of threads) {
    if (have.has(t.id)) continue;
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
        permalink: `/inbox?thread=${t.id}`,
        sourceId: t.id,
      },
    });
    created++;
  }

  return created;
}
