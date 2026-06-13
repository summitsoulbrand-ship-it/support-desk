/**
 * Social Comment AI Suggestion API
 * Generate suggested replies for social media comments
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import Anthropic from '@anthropic-ai/sdk';
import { getClaudeConfig } from '@/lib/claude';
import { normalizeModel } from '@/lib/claude/service';
import { BRAND_VOICE_GUIDELINES } from '@/lib/claude/brand-voice';
import { getSocialKnowledgeText } from '@/lib/social/knowledge';

type RouteContext = {
  params: Promise<{ id: string }>;
};

const SOCIAL_SYSTEM_PROMPT = `You are the customer service voice of Summit Soul (summitsoul.shop), a small made-to-order apparel brand selling funny nature graphic t-shirts, long sleeves, hoodies, and sweatshirts. You draft PUBLIC replies to Facebook and Instagram comments. They appear publicly under the brand's posts and ads, so they represent the company - use the exact same voice as the brand's customer service emails.

${BRAND_VOICE_GUIDELINES}

## Social format (this channel only)
- SHORT: 1-3 sentences. A public comment, not an email - no greeting line, no signature.
- 0-1 emoji max, only when it genuinely fits. Never use an emoji to soften a complaint.

## Rules
1. Positive comment -> thank them genuinely and specifically.
2. Question -> answer if you can from the post/product context; otherwise invite them to send a direct message or email support@summitsoul.shop.
3. Complaint or order issue -> apologize briefly and sincerely, then move it private: ask them to send a direct message or email support@summitsoul.shop with their order number. NEVER discuss order details, tracking, or personal info publicly.
4. Never promise a specific refund, replacement, or outcome publicly.
5. Don't be defensive, don't argue, and don't over-explain. Keep it calm and brief.

Return ONLY the reply text - no internal notes or formatting.`;

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

    // Call Claude API
    const client = new Anthropic({ apiKey });
    const model =
      normalizeModel(claudeConfig?.model) ||
      process.env.ANTHROPIC_MODEL ||
      'claude-opus-4-8';

    // Product questions and order asks get the full catalog (on-demand only,
    // so the token cost is per click, not per comment)
    const includeProducts =
      comment.category === 'QUESTION' || comment.category === 'ORDER';

    const response = await client.messages.create({
      model,
      max_tokens: 1024, // Headroom for refining longer drafts
      system:
        SOCIAL_SYSTEM_PROMPT + (await getSocialKnowledgeText({ includeProducts })),
      messages: [
        {
          role: 'user',
          content: userMessage,
        },
      ],
    });

    const textContent = response.content.find((c) => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text content in response');
    }

    // Clean up the response
    let draft = textContent.text.trim().replace(/\s*[—–]\s*/g, ' - ');

    // Remove any quotes that Claude might add
    if (draft.startsWith('"') && draft.endsWith('"')) {
      draft = draft.slice(1, -1);
    }

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
