/**
 * Rules engine - apply tag and assignment rules to threads
 */

import prisma from '@/lib/db';

interface ThreadContext {
  subject: string;
  customerEmail: string;
  bodyText?: string | null;
  tags?: string[]; // Tag names already applied
}

/**
 * Parse value for multiple keywords
 * Supports:
 * - Single keyword: "address"
 * - Multiple keywords (ALL must match): "address, change" or "address + change"
 * Returns array of keywords to match
 */
function parseKeywords(value: string): string[] {
  // Split by comma or plus sign, trim whitespace
  return value
    .split(/[,+]/)
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);
}

/**
 * Check if ALL keywords are present in the text
 */
function containsAllKeywords(text: string, keywords: string[]): boolean {
  const lowerText = text.toLowerCase();
  return keywords.every((keyword) => lowerText.includes(keyword));
}

/**
 * Check if a condition matches against the thread context
 */
function matchesCondition(
  condition: string,
  value: string,
  context: ThreadContext
): boolean {
  const lowerValue = value.toLowerCase();

  switch (condition) {
    case 'SUBJECT_CONTAINS': {
      const keywords = parseKeywords(value);
      return containsAllKeywords(context.subject, keywords);
    }

    case 'SUBJECT_STARTS_WITH':
      return context.subject.toLowerCase().startsWith(lowerValue);

    case 'EMAIL_CONTAINS':
      return context.customerEmail.toLowerCase().includes(lowerValue);

    case 'EMAIL_DOMAIN': {
      const domain = context.customerEmail.split('@')[1]?.toLowerCase();
      return domain === lowerValue;
    }

    case 'BODY_CONTAINS': {
      const keywords = parseKeywords(value);
      return containsAllKeywords(context.bodyText || '', keywords);
    }

    case 'WEEKDAY': {
      const today = new Date().getDay(); // 0=Sunday, 1=Monday, etc.
      const days = value.split(',').map((d) => parseInt(d.trim()));
      return days.includes(today);
    }

    case 'TIME_RANGE': {
      const [start, end] = value.split('-');
      if (!start || !end) return false;

      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();

      const [startH, startM] = start.split(':').map(Number);
      const [endH, endM] = end.split(':').map(Number);

      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;

      // Handle overnight ranges (e.g., 22:00-06:00)
      if (endMinutes < startMinutes) {
        return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
      }

      return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    }

    case 'HAS_TAG':
      return (context.tags || []).some(
        (t) => t.toLowerCase() === lowerValue
      );

    default:
      return false;
  }
}

/**
 * Apply tag rules to a thread and return matching tag IDs
 */
export async function applyTagRules(
  context: ThreadContext
): Promise<string[]> {
  try {
    const rules = await prisma.tagRule.findMany({
      where: { enabled: true },
      include: {
        tag: { select: { id: true, name: true } },
      },
    });

    const matchingTagIds: string[] = [];

    for (const rule of rules) {
      if (matchesCondition(rule.condition, rule.value, context)) {
        matchingTagIds.push(rule.tagId);
      }
    }

    return [...new Set(matchingTagIds)]; // Remove duplicates
  } catch (err) {
    console.error('[TagRules] Error applying tag rules:', err);
    return [];
  }
}

/**
 * Check filter rules and return true if thread should be trashed
 */
export async function applyFilterRules(
  context: ThreadContext
): Promise<boolean> {
  try {
    const rules = await prisma.filterRule.findMany({
      where: { enabled: true },
      orderBy: { createdAt: 'asc' },
    });

    if (rules.length === 0) {
      return false;
    }

    for (const rule of rules) {
      const matched = matchesCondition(rule.condition, rule.value, context);
      if (matched) {
        console.log(`[FilterRules] Trashing thread - rule "${rule.name}" matched subject: "${context.subject}"`);
        return true;
      }
    }

    return false;
  } catch (err) {
    console.error('[FilterRules] Error checking filter rules:', err);
    return false;
  }
}

/**
 * Find matching assignment rule and return user ID to assign to
 */
export async function findAssignment(
  context: ThreadContext
): Promise<string | null> {
  try {
    const rules = await prisma.assignmentRule.findMany({
      where: { enabled: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      include: {
        assignTo: { select: { id: true, active: true } },
      },
    });

    for (const rule of rules) {
      // Skip if assigned user is inactive
      if (!rule.assignTo.active) continue;

      if (matchesCondition(rule.condition, rule.value, context)) {
        return rule.assignToId;
      }
    }

    return null;
  } catch (err) {
    console.error('[AssignmentRules] Error finding assignment:', err);
    return null;
  }
}

/**
 * Apply all rules to a thread (both tags and assignment)
 */
export async function applyRulesToThread(
  threadId: string,
  context: ThreadContext
): Promise<{
  tagsApplied: number;
  assignedTo: string | null;
  trashed?: boolean;
}> {
  // Check auto-trash rules first
  const shouldTrash = await applyFilterRules(context);
  if (shouldTrash) {
    await prisma.thread.update({
      where: { id: threadId },
      data: { status: 'TRASHED' },
    });
    return { tagsApplied: 0, assignedTo: null, trashed: true };
  }

  // First apply tag rules
  const tagIds = await applyTagRules(context);

  if (tagIds.length > 0) {
    // Add tags to thread (ignore duplicates)
    await Promise.all(
      tagIds.map(async (tagId) => {
        try {
          await prisma.threadTag.create({
            data: { threadId, tagId },
          });
        } catch {
          // Ignore duplicate key errors
        }
      })
    );
  }

  // Get applied tags for assignment rules that check HAS_TAG
  const appliedTags = await prisma.threadTag.findMany({
    where: { threadId },
    include: { tag: { select: { name: true } } },
  });
  const tagNames = appliedTags.map((tt) => tt.tag.name);

  // Now apply assignment rules (including HAS_TAG)
  const assignedUserId = await findAssignment({
    ...context,
    tags: tagNames,
  });

  if (assignedUserId) {
    await prisma.thread.update({
      where: { id: threadId },
      data: { assignedUserId },
    });
  }

  return {
    tagsApplied: tagIds.length,
    assignedTo: assignedUserId,
    trashed: false,
  };
}
