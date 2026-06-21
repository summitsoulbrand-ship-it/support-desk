/**
 * On-demand draft-accuracy eval. ENQUEUES a run (sets a Redis flag); the worker
 * picks it up within ~60s and runs it there - the worker is long-lived and
 * survives web redeploys, unlike a fire-and-forget on this web process. The
 * result is persisted (shown in Settings) and emailed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, isAdmin } from '@/lib/auth';
import { cacheGet, cacheSet } from '@/lib/cache';
import { EVAL_REQUEST_KEY, EVAL_RUNNING_KEY } from '@/lib/eval/run-draft-eval';

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Don't double-queue if one is already running or queued.
    if (await cacheGet<boolean>(EVAL_RUNNING_KEY)) {
      return NextResponse.json(
        { started: false, message: 'An eval is already running - the result will appear here shortly.' },
        { status: 409 }
      );
    }
    if (await cacheGet<unknown>(EVAL_REQUEST_KEY)) {
      return NextResponse.json(
        { started: false, message: 'An eval is already queued - it starts within a minute.' },
        { status: 409 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const days = Number.isFinite(body?.days) ? Number(body.days) : 30;
    const limit = Math.min(Number.isFinite(body?.limit) ? Number(body.limit) : 120, 300);
    const toEmail = session.user.email || undefined;

    // Queue it for the worker (TTL 1h so a stuck request self-clears).
    await cacheSet(EVAL_REQUEST_KEY, { days, limit, toEmail }, 60 * 60);

    return NextResponse.json({
      started: true,
      message: `Queued. The worker runs it within a minute on up to ${limit} recent replied threads (last ${days} days); the score will appear here and email you in a few minutes.`,
    });
  } catch (err) {
    console.error('[admin/eval/run] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
