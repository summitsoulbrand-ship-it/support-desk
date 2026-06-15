/**
 * Deterministic "is this an unsubscribe?" check.
 *
 * A safety net so obvious opt-outs ("STOP", "unsubscribe", "remove me") are
 * caught even if the AI triage missed it or the thread was classified before
 * the UNSUBSCRIBE intent existed. Kept deliberately tight to avoid false
 * positives like "I tried to unsubscribe but it didn't work".
 */
/** Plain text from a message, falling back to stripped HTML (some emails have
 *  no text part - e.g. an iPhone "STOP" reply that's HTML-only). */
export function plainTextFromMessage(
  m?: { bodyText?: string | null; bodyHtml?: string | null } | null
): string {
  if (!m) return '';
  if (m.bodyText && m.bodyText.trim()) return m.bodyText;
  if (m.bodyHtml) {
    return m.bodyHtml
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&');
  }
  return '';
}

export function isUnsubscribeText(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  if (!t) return false;
  // Starts with a clear opt-out word/phrase.
  if (
    /^(stop|unsubscribe|remove me|opt[\s-]?out|take me off|cancel (my )?subscription)\b/.test(
      t
    )
  ) {
    return true;
  }
  // "unsubscribe" / "opt out" near the start of a message.
  const head = t.slice(0, 300);
  return /\bunsubscribe\b/.test(head) || /\bopt[\s-]?out\b/.test(head);
}
