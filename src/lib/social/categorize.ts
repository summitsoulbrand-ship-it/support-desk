/**
 * Heuristic comment categorization - no AI calls, pure string shape.
 * Priority sorting for the social inbox: complaints surface first, friend
 * tags sink to the bottom (and can be bulk-liked away).
 */

export type CommentCategory = 'COMPLAINT' | 'QUESTION' | 'OTHER' | 'TAG';

export const CATEGORY_RANK: Record<CommentCategory, number> = {
  COMPLAINT: 0,
  QUESTION: 1,
  OTHER: 2,
  TAG: 3,
};

const COMPLAINT_PATTERNS: RegExp[] = [
  /never (got|received|arrived|came|showed)/,
  /didn'?t (get|receive|arrive|come|ship)/,
  /haven'?t (got|gotten|received|seen)/,
  /where('s| is| are)? my/,
  /no (reply|response|answer|refund|tracking)/,
  /still (waiting|nothing|no)/,
  /scam/, /fraud/, /rip.?off/, /ripped off/,
  /refund/, /money back/, /charge?d (me|twice)/,
  /disappoint/, /terrible/, /awful/, /horrible/, /worst/,
  /poor quality/, /cheap quality/, /bad quality/, /fell apart/,
  /faded/, /shrunk/, /peeling/, /cracked/,
  /wrong (size|item|order|shirt|color|address)/,
  /damaged/, /defect/, /misprint/, /hole/,
  /cancel my/, /never order(ing)? again/, /don'?t (order|buy)/,
  /waste of money/, /junk/, /unanswered/, /no one (answers|responds)/,
  /customer service/, /complaint/, /unacceptable/,
];

const QUESTION_START =
  /^(is|are|do|does|did|can|could|will|would|how|what|when|where|why|who|any chance|anyone know)\b/i;

/** Strip emoji + decorative punctuation to judge the words underneath */
function significantText(text: string): string {
  return text
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}️]/gu, ' ')
    .replace(/[!.,;:'"()\[\]~*_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function categorizeComment(message: string | null | undefined): CommentCategory {
  const text = (message || '').trim();
  // No text at all = sticker/GIF/photo-only or a pure tag
  if (!text) return 'TAG';

  const lower = text.toLowerCase();
  if (COMPLAINT_PATTERNS.some((re) => re.test(lower))) return 'COMPLAINT';

  // Tag-only: a handful of name-shaped words ("Travis Robinson",
  // "Deborah Fiona Eyer"), optionally with emoji - nothing else said
  const stripped = significantText(text);
  const words = stripped.split(' ').filter(Boolean);
  const nameShaped =
    words.length > 0 &&
    words.length <= 4 &&
    words.every((w) => /^[A-Z][\p{L}'’.]*$/u.test(w));
  if (nameShaped && !text.includes('?')) return 'TAG';

  if (text.includes('?') || QUESTION_START.test(stripped)) return 'QUESTION';

  return 'OTHER';
}
