/**
 * Extract the readable part of an email: the latest reply, with quoted history
 * stripped. Shared by the message view (display) AND the AI context builder, so
 * the model reads the SAME clean text the operator sees - not the raw body with
 * walls of "On ... wrote: > ..." history, which buries the actual question.
 *
 * Forwarded emails are the exception: their real content lives inside the
 * forwarded block, so when the message looks like a forward we keep the full
 * body (a "see below" intro alone is useless).
 *
 * Pure string functions only - safe to import from both server and client.
 */

export interface EmailBodyInput {
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

export function latestReplyText(message: EmailBodyInput): string {
  const textPart = message.bodyText || '';
  const htmlHasBlocks = /<(br|p|div)\b/i.test(message.bodyHtml || '');
  // Prefer bodyText, but if it collapsed line breaks (single-line text part)
  // derive from HTML, which preserves paragraph structure via block tags.
  const useHtml = !textPart || (!textPart.includes('\n') && htmlHasBlocks);
  const raw = (!useHtml && textPart) || htmlToText(message.bodyHtml || '');

  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const l = line.trim();
    if (/^On .{5,120} wrote:\s*$/.test(l)) break;
    if (/^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(l)) break;
    if (/^_{8,}\s*$/.test(l)) break;
    if (l.startsWith('>')) break;
    kept.push(line);
  }
  const result = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const rawTrimmed = raw.trim();

  // Forward detection: subject starts with Fwd:/FW:, or the body has a forward
  // separator and almost nothing survived stripping (a thin intro). A normal
  // reply that merely quotes a forward keeps long stripped text, so it isn't
  // over-shown.
  const subjectIsForward = /^\s*(fwd?|fw)\s*:/i.test(message.subject || '');
  const bodyHasForwardMarker =
    /^[-_]{2,}\s*forwarded message\s*[-_]{2,}/im.test(raw) ||
    /^begin forwarded message:/im.test(raw);
  const isForward =
    subjectIsForward || (bodyHasForwardMarker && result.length < 60);
  if (isForward && rawTrimmed.length > result.length) return rawTrimmed;

  return result || rawTrimmed;
}
