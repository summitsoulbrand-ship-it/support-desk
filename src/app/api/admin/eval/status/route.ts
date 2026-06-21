/**
 * Status of the draft-accuracy eval for the Settings card: whether one is
 * running/queued and the latest stored result (so the score is visible in-app,
 * not only by email).
 */

import { NextResponse } from 'next/server';
import { getSession, isAdmin } from '@/lib/auth';
import { cacheGet } from '@/lib/cache';
import {
  EVAL_RESULT_KEY,
  EVAL_REQUEST_KEY,
  EVAL_RUNNING_KEY,
  type StoredEvalResult,
} from '@/lib/eval/run-draft-eval';

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!isAdmin(session.user.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const [running, queued, last] = await Promise.all([
      cacheGet<boolean>(EVAL_RUNNING_KEY),
      cacheGet<unknown>(EVAL_REQUEST_KEY),
      cacheGet<StoredEvalResult>(EVAL_RESULT_KEY),
    ]);

    return NextResponse.json({
      running: !!running,
      queued: !!queued,
      last: last || null,
    });
  } catch (err) {
    console.error('[admin/eval/status] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
