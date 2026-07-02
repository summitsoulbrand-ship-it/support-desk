/**
 * Claude suggestion API - Generate suggested reply drafts
 * Delegates context building to the shared builder (same code path as the
 * background pre-draft pipeline) with live order/tracking data.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { createClaudeService } from '@/lib/claude';
import { buildThreadSuggestionContext } from '@/lib/ai/context';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!hasPermission(session.user.role, 'REPLY_THREADS')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await context.params;

    // Parse optional refinement parameters from request body
    let currentDraft: string | undefined;
    let refinementInstructions: string | undefined;

    try {
      const contentType = request.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        const body = await request.json();
        currentDraft = body.currentDraft;
        refinementInstructions = body.instructions;
      }
    } catch {
      // No body or invalid JSON - proceed without refinement
    }

    // Get current user with signature
    const currentUser = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { name: true, signature: true },
    });

    const claudeService = await createClaudeService();
    if (!claudeService) {
      return NextResponse.json(
        { error: 'Claude API not configured' },
        { status: 503 }
      );
    }

    // Refinements only rewrite an existing draft, so cached context is fine;
    // fresh generations always pull live order/tracking data.
    const isRefinement = Boolean(currentDraft && refinementInstructions);

    const built = await buildThreadSuggestionContext(id, {
      forceFresh: !isRefinement,
      agent: currentUser
        ? {
            name: currentUser.name,
            signature: currentUser.signature || undefined,
          }
        : undefined,
    });

    if (!built) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    }

    if (isRefinement) {
      built.context.refinement = {
        currentDraft: currentDraft!,
        instructions: refinementInstructions!,
      };
    }

    const suggestion = await claudeService.generateSuggestion(built.context);

    if (built.warnings.length > 0) {
      suggestion.warnings = [...built.warnings, ...(suggestion.warnings || [])];
    }

    // QA pass (cheap Haiku call): flag unsupported claims, wrong-order
    // references, and missed questions as warnings on the draft. Fresh
    // generations only - refinements are operator-steered and stay snappy.
    if (!isRefinement && suggestion.draft?.trim()) {
      const verdict = await claudeService.verifyDraft(
        built.context,
        suggestion.draft
      );
      if (verdict.issues.length > 0) {
        suggestion.warnings = [...(suggestion.warnings || []), ...verdict.issues];
      }
    }

    // Keep the persisted draft in step with what the agent now sees
    if (!isRefinement) {
      await prisma.aiDraft.upsert({
        where: { threadId: id },
        create: {
          threadId: id,
          forMessageId: built.latestInboundMessageId,
          body: suggestion.draft,
          status: 'READY',
          warnings: suggestion.warnings?.length ? suggestion.warnings : undefined,
          model: claudeService.getModel(),
          contextRefreshedAt: built.contextRefreshedAt,
        },
        update: {
          forMessageId: built.latestInboundMessageId,
          body: suggestion.draft,
          status: 'READY',
          warnings: suggestion.warnings?.length ? suggestion.warnings : undefined,
          model: claudeService.getModel(),
          contextRefreshedAt: built.contextRefreshedAt,
          error: null,
        },
      });
    }

    return NextResponse.json(suggestion);
  } catch (err) {
    console.error('Error generating suggestion:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    // Anthropic capacity blips (529 overloaded / 429): plain-language error
    // instead of raw JSON at the operator - it clears on its own.
    if (/overloaded|529|rate limit|429/i.test(message)) {
      return NextResponse.json(
        {
          error:
            'The AI service is briefly overloaded - this clears on its own. Try Suggest Reply again in a minute.',
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: `Failed to generate suggestion: ${message}` },
      { status: 500 }
    );
  }
}
