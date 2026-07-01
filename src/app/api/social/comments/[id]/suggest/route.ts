/**
 * Social Comment AI Suggestion API
 * Generate suggested replies for social media comments
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { ClaudeService, getClaudeConfig } from '@/lib/claude';
import { getSocialKnowledgeText } from '@/lib/social/knowledge';

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

    // Parse optional refinement from request body
    let currentDraft: string | undefined;
    let instructions: string | undefined;

    try {
      const contentType = request.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        const body = await request.json();
        currentDraft = body.currentDraft;
        instructions = body.instructions;
      }
    } catch {
      // No body or invalid JSON - proceed without refinement
    }

    // Get comment with context
    const comment = await prisma.socialComment.findUnique({
      where: { id },
      include: {
        account: {
          select: {
            name: true,
            platform: true,
          },
        },
        object: {
          select: {
            type: true,
            message: true,
            adName: true,
          },
        },
        parent: {
          select: {
            authorName: true,
            message: true,
          },
        },
        replies: {
          where: { deleted: false },
          orderBy: { commentedAt: 'asc' },
          select: {
            authorName: true,
            message: true,
            isPageOwner: true,
          },
        },
      },
    });

    if (!comment) {
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
    }

    // Use the same stored Claude settings as email drafting (the env var
    // fallback is for local dev only)
    const claudeConfig = await getClaudeConfig();
    const apiKey = claudeConfig?.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Claude API not configured' },
        { status: 503 }
      );
    }

    // Build context message
    let userMessage = '## Context\n\n';
    userMessage += `Platform: ${comment.platform}\n`;
    userMessage += `Account: ${comment.account.name}\n`;

    if (comment.object) {
      userMessage += `\n### Original ${comment.object.type === 'AD' ? 'Ad' : 'Post'}\n`;
      if (comment.object.adName) {
        userMessage += `Ad Name: ${comment.object.adName}\n`;
      }
      if (comment.object.message) {
        userMessage += `Content: ${comment.object.message.substring(0, 500)}${comment.object.message.length > 500 ? '...' : ''}\n`;
      }
    }

    // If this is a reply to another comment, include parent context
    if (comment.parent) {
      userMessage += `\n### Parent Comment\n`;
      userMessage += `From: ${comment.parent.authorName}\n`;
      userMessage += `Message: ${comment.parent.message}\n`;
    }

    // The main comment we're replying to
    userMessage += `\n### Comment to Reply To\n`;
    userMessage += `From: ${comment.authorName}`;
    if (comment.authorUsername) {
      userMessage += ` (@${comment.authorUsername})`;
    }
    userMessage += `\n`;
    userMessage += `Message: ${comment.message}\n`;

    // Include any existing replies for context
    if (comment.replies.length > 0) {
      userMessage += `\n### Existing Replies in Thread\n`;
      for (const reply of comment.replies) {
        const sender = reply.isPageOwner ? '[Our Reply]' : reply.authorName;
        userMessage += `${sender}: ${reply.message}\n`;
      }
    }

    // Task instructions
    if (currentDraft && instructions) {
      userMessage += `\n## Current Draft\n${currentDraft}\n`;
      userMessage += `\n## Refinement Instructions\n${instructions}\n`;
      userMessage += `\n## Task\nRevise the draft according to the instructions. Return only the revised reply.`;
    } else {
      userMessage += `\n## Task\nDraft a helpful, friendly reply to this comment. Keep it concise and appropriate for ${comment.platform}.`;
    }

    // Product questions and order asks get the full catalog (on-demand only,
    // so the token cost is per click, not per comment)
    const includeProducts =
      comment.category === 'QUESTION' || comment.category === 'ORDER';

    // All AI drafting goes through the shared ClaudeService (social channel):
    // it supplies the social system prompt + operator instructions, runs the
    // model id through normalizeModel() so a stale/retired id can't 404, and
    // applies the shared reply cleanup (no em dashes, no wrapping quotes).
    const claude = new ClaudeService({
      ...(claudeConfig || {}),
      apiKey,
      model: claudeConfig?.model || process.env.ANTHROPIC_MODEL,
    });

    const draft = await claude.generateSocialReply(userMessage, {
      maxTokens: 1024, // Headroom for refining longer drafts
      knowledgeText: await getSocialKnowledgeText({ includeProducts }),
    });

    return NextResponse.json({
      draft,
      confidence: 0.85,
    });
  } catch (err) {
    console.error('Error generating social suggestion:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `Failed to generate suggestion: ${message}` },
      { status: 500 }
    );
  }
}
