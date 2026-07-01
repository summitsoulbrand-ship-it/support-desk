/**
 * Self-service magic-link tokens.
 *
 * The raw token is a 32-byte random string that only ever travels in the email
 * link sent to the address on the order. We persist only its SHA-256 hash, so a
 * database leak does not hand anyone a working link. Tokens are single-use
 * (consumed atomically) and short-lived.
 */

import crypto from 'crypto';
import prisma from '@/lib/db';

export const TOKEN_TTL_MINUTES = 30;

export type SelfServicePurpose = 'CANCEL' | 'WITHDRAW';

export function generateRawToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export interface CreateTokenInput {
  purpose: SelfServicePurpose;
  shopifyOrderId: string;
  shopifyOrderName: string;
  email: string;
  printifyOrderId?: string | null;
  requestIp?: string | null;
}

/**
 * Create a token row and return the raw token to embed in the magic link.
 * Any earlier unconsumed tokens for the same order + purpose are voided in the
 * same transaction, so only the NEWEST link ever works - re-requesting a link
 * kills every older email instead of leaving a pile of live siblings.
 */
export async function createSelfServiceToken(
  input: CreateTokenInput
): Promise<string> {
  const raw = generateRawToken();
  await prisma.$transaction([
    prisma.selfServiceToken.updateMany({
      where: {
        shopifyOrderId: input.shopifyOrderId,
        purpose: input.purpose,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    }),
    prisma.selfServiceToken.create({
      data: {
        tokenHash: hashToken(raw),
        purpose: input.purpose,
        shopifyOrderId: input.shopifyOrderId,
        shopifyOrderName: input.shopifyOrderName,
        email: input.email.toLowerCase(),
        printifyOrderId: input.printifyOrderId ?? null,
        requestIp: input.requestIp ?? null,
        expiresAt: new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000),
      },
    }),
  ]);
  return raw;
}

export type ValidToken = NonNullable<
  Awaited<ReturnType<typeof getValidToken>>
>;

/**
 * Look up a token by its raw value. Returns the row only if it exists, has not
 * been consumed, and has not expired. Does NOT consume it (used by the preview
 * GET handler).
 */
export async function getValidToken(raw: string) {
  if (!raw) return null;
  const row = await prisma.selfServiceToken.findUnique({
    where: { tokenHash: hashToken(raw) },
  });
  if (!row) return null;
  if (row.consumedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

/**
 * Atomically consume a token. Returns true only if THIS call flipped it from
 * unconsumed -> consumed, so two concurrent requests from one link can never
 * both proceed. Pass the row id from getValidToken().
 */
export async function consumeToken(id: string): Promise<boolean> {
  const res = await prisma.selfServiceToken.updateMany({
    where: { id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return res.count === 1;
}

/** Roll back a consume() if the downstream action failed (lets the link retry). */
export async function releaseToken(id: string): Promise<void> {
  await prisma.selfServiceToken
    .updateMany({ where: { id }, data: { consumedAt: null } })
    .catch(() => undefined);
}
