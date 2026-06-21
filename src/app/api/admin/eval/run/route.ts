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
const COOLDOWN_SECONDS = 120;

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
    const limit = Number.isFinite(body?.limit) ? Number(body.limit) : 40;
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
      message: `Running the eval on the last ${days} days (${limit} threads). You'll get the score by email in a couple of minutes.`,
    });
  } catch (err) {
    console.error('[admin/eval/run] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
