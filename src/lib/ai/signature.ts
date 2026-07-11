/**
 * Personalize a pre-generated draft's signature for whoever is viewing it.
 *
 * Background drafts are written ahead of time, so they carry whatever
 * signature existed at bake time: another agent's, or - for drafts baked
 * before signatures were set up in Settings - the AI's old hardcoded
 * "Best, Pati / Summit Soul" sign-off. When an agent opens the thread, swap
 * that baked-in ending for THEIR signature so the reply they send is signed
 * correctly. Manual "Suggest Reply" drafts are generated with the viewer's
 * own signature, so this is a no-op for those.
 */

import prisma from '@/lib/db';

/**
 * The sign-off the AI prompt used before agents had signatures in Settings.
 * Models rendered it with varying separators ("Best,\nPati\nSummit Soul",
 * "Best, Pati / Summit Soul"), so match any whitespace/slash mix. Anchored to
 * the end of the draft so a "Pati" inside the message text is never touched.
 */
const LEGACY_SIGNOFF_RE = /\n\s*Best,[\s/]*Pati(?:[\s/]+Summit Soul)?\s*$/;

export async function personalizeDraftSignature(
  body: string,
  viewerUserId: string
): Promise<string> {
  if (!body) return body;

  const viewer = await prisma.user.findUnique({
    where: { id: viewerUserId },
    select: { id: true, signature: true },
  });

  // No signature of their own -> leave the baked one in place (better a real
  // signature than none); they should set one in Settings.
  const viewerSig = viewer?.signature?.trim() ? viewer.signature : null;
  if (!viewerSig) return body;

  // Draft already ends with the viewer's signature - nothing to do.
  if (body.includes(viewerSig)) return body;

  // Baked with ANOTHER user's signature -> swap it for the viewer's. Check
  // every account with a signature, not just the oldest admin - the oldest
  // admin can be a placeholder account with no signature at all.
  const others = await prisma.user.findMany({
    where: { id: { not: viewerUserId } },
    select: { signature: true },
  });
  for (const u of others) {
    const sig = u.signature?.trim() ? u.signature : null;
    if (sig && sig !== viewerSig && body.includes(sig)) {
      return body.split(sig).join(viewerSig);
    }
  }

  // Baked before signatures existed -> ends with the old hardcoded sign-off.
  if (LEGACY_SIGNOFF_RE.test(body)) {
    return body.replace(LEGACY_SIGNOFF_RE, `\n\n${viewerSig}`);
  }

  return body;
}
