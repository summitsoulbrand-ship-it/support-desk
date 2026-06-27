/**
 * On-demand Printify recovery reconcile: scan recent Printify support emails
 * (Gmail) for refund/reprint/cancel confirmations and auto-tick the Late
 * Deliveries "Refunded by Printify" flag. Mirrors the worker loop, for the
 * operator (and a quick manual run after configuring the Gmail app password).
 *
 *   POST /api/late-orders/reconcile-printify?days=120
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import { reconcilePrintifyRecoveries } from '@/lib/printify/recovery';
import { gmailConfigFromEnv } from '@/lib/email/gmail-printify-reader';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasPermission(session.user.role, 'REPLY_THREADS')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (!gmailConfigFromEnv()) {
    return NextResponse.json(
      {
        error:
          'Gmail not configured. Set GMAIL_IMAP_USER and GMAIL_IMAP_PASSWORD ' +
          '(a Gmail app password for summitsoulbrand@gmail.com) on the worker + web services.',
      },
      { status: 400 }
    );
  }

  const daysParam = parseInt(request.nextUrl.searchParams.get('days') || '120', 10);
  const sinceDays = Number.isFinite(daysParam)
    ? Math.min(Math.max(daysParam, 1), 365)
    : 120;

  try {
    const stats = await reconcilePrintifyRecoveries({ sinceDays });
    return NextResponse.json({ success: true, stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Reconcile failed';
    console.error('[reconcile-printify] failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
