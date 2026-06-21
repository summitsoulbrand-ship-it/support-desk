/**
 * "What the AI saw" - returns the EXACT facts block the draft model receives
 * for this thread (clean message history + the orders/items/tracking it was
 * given), so the operator can confirm the draft was grounded in the right data
 * (e.g. that the AI actually got the 2nd order, the items, the prior emails).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import { buildThreadSuggestionContext } from '@/lib/ai/context';
import { createClaudeService } from '@/lib/claude';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!hasPermission(session.user.role, 'VIEW_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;

    // Same builder the draft pipeline uses; cache is fine for a review view.
    const built = await buildThreadSuggestionContext(id, { forceFresh: false });
    if (!built) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    }

    const claude = await createClaudeService();
    const facts = claude ? claude.renderContextForReview(built.context) : '';

    const orderCount =
      built.context.orderCandidates?.length ??
      (built.context.shopifyOrder ? 1 : 0);

    return NextResponse.json({
      facts,
      warnings: built.warnings,
      orderCount,
      messageCount: built.context.messages.length,
      matchedOrder: built.context.orderMatch?.matchedOrderNumber ?? null,
      ambiguousOrder: built.context.orderMatch?.ambiguous ?? false,
      contextRefreshedAt: built.contextRefreshedAt,
    });
  } catch (err) {
    console.error('Error building AI-context review:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
