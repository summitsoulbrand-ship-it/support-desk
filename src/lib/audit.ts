/**
 * Action audit log + money-action governance.
 *
 * With more than one agent handling tickets, this is the append-only record
 * of who refunded / cancelled / replaced / discounted what, and the gate that
 * can require an admin for large refunds.
 */

import prisma from '@/lib/db';

export interface LogActionInput {
  threadId?: string | null;
  userId?: string | null;
  userName: string;
  action: string;
  summary: string;
  amountCents?: number | null;
  orderName?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Record an action. Never throws - auditing must not break the action. */
export async function logAction(input: LogActionInput): Promise<void> {
  try {
    await prisma.actionLog.create({
      data: {
        threadId: input.threadId ?? null,
        userId: input.userId ?? null,
        userName: input.userName,
        action: input.action,
        summary: input.summary,
        amountCents: input.amountCents ?? null,
        orderName: input.orderName ?? null,
        metadata: (input.metadata as object) ?? undefined,
      },
    });
  } catch (err) {
    console.error('[audit] failed to log action:', err);
  }
}

/** Dollars string ("44.00", "$12") -> integer cents. Null when unparseable. */
export function dollarsToCents(amount?: string | null): number | null {
  if (!amount) return null;
  const n = parseFloat(String(amount).replace(/[^0-9.]/g, ''));
  if (!isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Refund amount (cents) at/above this needs an admin. 0 = no gate. */
export async function getRefundThresholdCents(): Promise<number> {
  const settings = await prisma.appSettings.findUnique({
    where: { id: 'default' },
    select: { refundApprovalThresholdCents: true },
  });
  return settings?.refundApprovalThresholdCents ?? 0;
}
