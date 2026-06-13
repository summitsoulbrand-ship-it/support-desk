/**
 * Personalize a pre-generated draft's signature for whoever is viewing it.
 *
 * Background drafts are written ahead of time and signed with the primary
 * admin's signature (we don't yet know which agent will handle the ticket).
 * When a different agent opens the thread, swap that baked-in signature for
 * THEIRS so the reply they send is signed correctly. Manual "Suggest Reply"
 * drafts are already personalized per-agent, so this is a no-op for those.
 */

import prisma from '@/lib/db';

/** The admin whose signature the background pipeline bakes into drafts. */
async function getPrimaryAdmin() {
  return prisma.user.findFirst({
    where: { role: 'ADMIN' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, signature: true },
  });
}

export async function personalizeDraftSignature(
  body: string,
  viewerUserId: string
): Promise<string> {
  if (!body) return body;

  const viewer = await prisma.user.findUnique({
    where: { id: viewerUserId },
    select: { id: true, signature: true },
  });

  // No signature of their own -> leave the owner's in place (better a real
  // signature than none); they should set one in Settings.
  if (!viewer?.signature?.trim()) return body;

  const admin = await getPrimaryAdmin();
  // Viewer IS the primary admin, or no admin signature was baked -> nothing
  // to swap.
  if (!admin?.signature?.trim() || admin.id === viewer.id) return body;

  if (!body.includes(admin.signature)) return body;
  return body.split(admin.signature).join(viewer.signature);
}
