/**
 * Wording and matching helpers for customer design ideas.
 *
 * Split out from `design-ideas.ts` on purpose: that module talks to the
 * database, and the ideas page is a client component that needs these strings.
 */

export const STORE_URL = 'https://summitsoul.shop';

export function productUrl(handle: string): string {
  return `${STORE_URL}/products/${handle}`;
}

/** First name only, so the note reads like a person wrote it. */
export function firstName(name?: string | null): string {
  const first = (name || '').trim().split(/\s+/)[0] || '';
  // An email address in the name slot is not a name.
  if (!first || first.includes('@')) return 'there';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** The customer's own words, trimmed to something quotable. */
export function quotable(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}...` : clean;
}

export interface MadeItNote {
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

/**
 * The "you asked, we drew it" note. Short, no sales pitch, the link doing the
 * work - this is a favor being returned, not a campaign.
 */
export function buildMadeItNote(idea: {
  text: string;
  authorName?: string | null;
  productTitle?: string | null;
  productHandle?: string | null;
}): MadeItNote {
  const name = firstName(idea.authorName);
  const title = idea.productTitle || 'the new design';
  const url = idea.productHandle ? productUrl(idea.productHandle) : STORE_URL;
  const quote = quotable(idea.text);

  const bodyText = [
    `Hi ${name},`,
    '',
    'You asked us for this a while back:',
    `"${quote}"`,
    '',
    'We drew it. Here it is:',
    `${title}`,
    url,
    '',
    'Thanks for the nudge. A good share of our designs start as somebody telling us what they wish existed.',
    '',
    'Pati',
    'Summit Soul',
  ].join('\n');

  const bodyHtml = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2937;">
  <p>Hi ${escapeHtml(name)},</p>
  <p>You asked us for this a while back:</p>
  <blockquote style="margin:0 0 16px;padding:8px 14px;border-left:3px solid #d1d5db;color:#4b5563;">${escapeHtml(quote)}</blockquote>
  <p>We drew it. Here it is:</p>
  <p><a href="${url}" style="color:#0f766e;font-weight:600;">${escapeHtml(title)}</a><br />
  <a href="${url}" style="color:#6b7280;font-size:13px;">${url}</a></p>
  <p>Thanks for the nudge. A good share of our designs start as somebody telling us what they wish existed.</p>
  <p>Pati<br />Summit Soul</p>
</div>`.trim();

  return {
    subject: 'You asked for this one, so we drew it',
    bodyText,
    bodyHtml,
  };
}

/** The same note as a short comment reply, for ideas that came off social. */
export function buildMadeItComment(idea: {
  authorName?: string | null;
  productTitle?: string | null;
  productHandle?: string | null;
}): string {
  const name = firstName(idea.authorName);
  const title = idea.productTitle || 'the new design';
  const url = idea.productHandle ? productUrl(idea.productHandle) : STORE_URL;
  const hi = name === 'there' ? 'Hi!' : `Hi ${name}!`;
  return `${hi} You asked for this one, so we drew it: ${title} ${url}`;
}

/** Search terms worth trying against the catalog for this idea. */
export function ideaSearchHint(text: string): string {
  const stop = new Set([
    'the', 'and', 'you', 'have', 'has', 'with', 'for', 'that', 'this', 'would',
    'could', 'love', 'like', 'want', 'make', 'made', 'please', 'shirt', 'tee',
    'tshirt', 't-shirt', 'design', 'one', 'any', 'are', 'was', 'can', 'get',
    'your', 'our', 'about', 'there', 'them', 'they', 'from', 'just', 'really',
    'maybe', 'thanks', 'thank', 'hello', 'hey', 'idea', 'suggestion', 'need',
  ]);
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
  // Longer words carry the subject ("chipmunk" beats "one"); keep the first
  // few in the order the customer said them.
  return words.slice(0, 3).join(' ');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Turn the (possibly hand-edited) plain-text note back into the HTML we send,
 * so what Pati reads in the box is exactly what lands in the customer's inbox.
 */
export function noteTextToHtml(text: string): string {
  const body = escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#0f766e;">$1</a>')
    .replace(/\n/g, '<br />');
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2937;">${body}</div>`;
}
