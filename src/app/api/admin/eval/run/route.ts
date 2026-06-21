/**
 * On-demand draft-accuracy eval. Runs server-side (where the prod DB + Claude
 * creds already work, so it sidesteps any local DB), fire-and-forget, and
 * emails the admin the score when done. Admin-gated, with a short cooldown so a
 * double-click can't kick two runs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, isAdmin } from '@/lib/auth';
import { cacheGet, cacheSet } from '@/lib/cache';
import { runEvalAndEmail } from '@/lib/eval/run-draft-eval';

const COOLDOWN_KEY = 'eval:manual-cooldown';
// A ~120-thread run takes several minutes; cool down long enough that an
// impatient re-click can't kick a second overlapping run.
const COOLDOWN_SECONDS = 600;

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (await cacheGet<number>(COOLDOWN_KEY)) {
      return NextResponse.json(
        { started: false, message: 'An eval just started - give it a minute, the score email is on its way.' },
        { status: 429 }
      );
    }
    await cacheSet(COOLDOWN_KEY, Date.now(), COOLDOWN_SECONDS);

    const body = await request.json().catch(() => ({}));
    const days = Number.isFinite(body?.days) ? Number(body.days) : 30;
    // Sample cap. Bounded so a run stays to a few minutes / reasonable cost;
    // raise it if you want a tighter estimate. Hard ceiling at 300.
    const limit = Math.min(Number.isFinite(body?.limit) ? Number(body.limit) : 120, 300);
    // Email the triggering admin if we know their address, else fall back to
    // the first admin (handled inside runEvalAndEmail).
    const toEmail = session.user.email || undefined;

    // Fire-and-forget: the eval takes a couple of minutes (generate + judge per
    // thread). Persistent Node server on Railway keeps the promise alive after
    // the response; the result arrives by email.
    void runEvalAndEmail({ days, limit, toEmail }).catch((err) =>
      console.error('[admin/eval/run] failed:', err)
    );

    return NextResponse.json({
      started: true,
      message: `Running the eval on a sample of up to ${limit} recent replied threads (last ${days} days). This takes a few minutes - you'll get the score by email when it's done.`,
    });
  } catch (err) {
    console.error('[admin/eval/run] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
