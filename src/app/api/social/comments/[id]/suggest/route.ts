/**
 * Social Comment AI Suggestion API
 * Generate suggested replies for social media comments
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import Anthropic from '@anthropic-ai/sdk';

type RouteContext = {
  params: Promise<{ id: string }>;
};

const SOCIAL_SYSTEM_PROMPT = `You are a friendly social media community manager. Your job is to draft helpful, engaging replies to comments on Facebook and Instagram posts.

## Brand Voice Guidelines
- Be warm, friendly, and authentic
- Use a conversational, casual tone appropriate for social media
- Keep responses concise (social media attention spans are short!)
- Show empathy and genuine interest in helping
- Use "we" when referring to the company

## Response Rules
1. Keep replies SHORT - typically 1-3 sentences
2. Be helpful without being overly formal
3. If the comment is positive, thank them genuinely
4. If it's a question, answer helpfully or offer to help via DM
5. If it's a complaint, acknowledge and offer to help
6. NEVER share sensitive information publicly - offer to move to DM for order/account issues
7. Match the energy of the original comment (excited response to excited comment, etc.)

## What NOT to do
- Don't be robotic or use corporate speak
- Don't write long paragraphs - this is social media!
- Don't share order details, tracking numbers, or personal info publicly
- Don't promise specific outcomes without being certain
- Don't use excessive emojis (1-2 max per reply is fine)
- Don't be defensive if the comment is negative

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

    // Check if Claude API is configured
    const apiKey = process.env.ANTHROPIC_API_KEY;
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
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

    const response = await client.messages.create({
      model,
      max_tokens: 500, // Social replies should be short
      system: SOCIAL_SYSTEM_PROMPT,
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
    let draft = textContent.text.trim();

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
