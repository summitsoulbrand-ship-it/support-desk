'use client';

/**
 * Thread view component - displays message history and reply composer
 */

import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  memo,
  forwardRef,
  useImperativeHandle,
} from 'react';
import dynamic from 'next/dynamic';
import { useSession } from 'next-auth/react';
import { cn, formatDateFull, formatDateRelative } from '@/lib/utils';
import { isUnsubscribeText, plainTextFromMessage } from '@/lib/unsubscribe-detect';
import { lintReply, type ReplyLintWarning } from '@/lib/reply-lint';
import {
  getReplyDraft,
  setReplyDraft,
  clearReplyDraft,
} from '@/hooks/reply-draft-store';
import { addSendError } from '@/hooks/use-send-errors';
import { useInboxShortcuts } from '@/hooks/use-inbox-shortcuts';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';

// TipTap is heavy - load the editor only when a thread is actually open so it
// stays out of the initial bundle (same pattern as the compose modal).
const RichTextEditor = dynamic(
  () => import('@/components/ui/rich-text-editor').then((m) => m.RichTextEditor),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-[130px] animate-pulse rounded-lg border bg-gray-50" />
    ),
  }
);
import {
  Send,
  Sparkles,
  CheckCircle,
  Clock,
  XCircle,
  User,
  Trash2,
  Paperclip,
  X,
  Image,
  FileText,
  Mail,
  Tag,
  Plus,
  AlertTriangle,
  ChevronDown,
  Pencil,
  ChevronsUpDown,
  Minimize2,
  MessageSquareText,
} from 'lucide-react';

interface Message {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  status: string;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  sentAt: string;
  isRead: boolean;
  attachments: {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    contentId?: string | null;
    storagePath?: string | null;
  }[];
}

interface TagData {
  id: string;
  name: string;
  color: string;
}

interface ThreadTriage {
  intent: string;
  confidence: number;
  entities?: Record<string, unknown> | null;
}

interface AiDraft {
  id: string;
  forMessageId: string | null;
  body: string;
  status: 'PENDING' | 'READY' | 'FAILED' | 'STALE' | 'AWAITING_ACTION';
  warnings?: string[] | null;
  contextRefreshedAt?: string | null;
  updatedAt: string;
}

interface Thread {
  id: string;
  subject: string;
  customerEmail: string;
  customerName: string | null;
  status: 'OPEN' | 'PENDING' | 'CLOSED' | 'TRASHED';
  assignedUser: {
    id: string;
    name: string;
  } | null;
  mailbox: {
    emailAddress: string;
  };
  messages: Message[];
  tags?: TagData[];
  triage?: ThreadTriage | null;
  aiDraft?: AiDraft | null;
  lastActionType?: string | null;
  lastActionAt?: string | null;
}

// A resolving action was taken on this thread via the tool (replacement,
// pre-production change, refund, cancel, escalation). Once one of these is
// recorded, the draft-stage warnings are stale/wrong, so they're suppressed.
const RESOLVED_ACTION_TYPES = [
  'replacement_created',
  'item_changed_preproduction',
  'order_edited',
  'order_refunded',
  'order_cancelled',
  'order_cancelled_both',
  'escalated_to_printify',
];

export const INTENT_LABELS: Record<string, { label: string; className: string }> = {
  SIZE_EXCHANGE: { label: 'Size exchange', className: 'bg-purple-100 text-purple-800' },
  SHIPPING_STATUS: { label: 'Shipping status', className: 'bg-blue-100 text-blue-800' },
  ADDRESS_UPDATE: { label: 'Address update', className: 'bg-amber-100 text-amber-800' },
  CANCELLATION: { label: 'Cancellation', className: 'bg-red-100 text-red-800' },
  ORDER_ISSUE: { label: 'Order issue', className: 'bg-rose-100 text-rose-800' },
  RETURN_REFUND: { label: 'Return / refund', className: 'bg-orange-100 text-orange-800' },
  DISCOUNT: { label: 'Discount', className: 'bg-pink-100 text-pink-800' },
  PRODUCT_QUESTION: { label: 'Product question', className: 'bg-teal-100 text-teal-800' },
  POSITIVE_FEEDBACK: { label: 'Positive feedback', className: 'bg-emerald-100 text-emerald-800' },
  UNSUBSCRIBE: { label: 'Suppress', className: 'bg-rose-100 text-rose-800' },
  WHOLESALE: { label: 'Wholesale', className: 'bg-indigo-100 text-indigo-800' },
  SPAM: { label: 'Spam / vendor', className: 'bg-gray-100 text-gray-500' },
  OTHER: { label: 'Other', className: 'bg-gray-100 text-gray-700' },
};
const FALLBACK_INTENT = { label: 'Other', className: 'bg-gray-100 text-gray-700' };

interface RelatedThread {
  id: string;
  subject: string;
  status: string;
  lastMessageAt: string;
  messageCount: number;
  preview?: string; // Last message preview
}

interface TeamUser {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'AGENT';
  active: boolean;
}

interface ThreadViewProps {
  threadId: string;
  onThreadDeleted?: () => void;
  onSelectThread?: (threadId: string) => void;
}

// Convert URLs in text to clickable links
/**
 * The readable part of a customer email: everything before quoted history
 * ("On ... wrote:", "> ..." lines, Outlook-style separators). Falls back to
 * the full text when nothing remains after stripping.
 *
 * EXCEPTION - forwarded emails: a forward's real content lives INSIDE the
 * forwarded block, so stripping "history" would hide the whole message (e.g.
 * an intro that only says "see below"). When the email is a forward we show
 * the full body instead, so the forwarded customer message is always visible
 * even if nothing was auto-detected from it.
 */
/** Convert an HTML email body to readable plain text: drop style blocks, turn
 *  block tags into line breaks, strip remaining tags, decode common entities.
 *  Tags are removed BEFORE entities are decoded, so entity-encoded angle
 *  brackets (literal text like &lt;b&gt;) survive instead of being eaten. */
function htmlToPlainText(s: string): string {
  return s
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

/**
 * Split a message into the customer's own latest reply and the quoted history
 * beneath it (the email they replied to). The reply renders in the bubble; the
 * quoted part is offered as a collapsible "Show quoted email" block so the
 * operator can see what triggered the message - common when a customer replies
 * to one of our shipping/order notifications and only their one-liner is "new".
 */
function splitReply(message: {
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
}): { reply: string; quoted: string } {
  // Prefer bodyText, but when it collapsed the line breaks (some senders
  // store a single-line text part) fall back to deriving from the HTML,
  // which preserves paragraph structure via its block tags
  const textPart = message.bodyText || '';
  const htmlHasBlocks = /<(br|p|div)\b/i.test(message.bodyHtml || '');
  const useHtml = (!textPart || (!textPart.includes('\n') && htmlHasBlocks));
  const raw = (!useHtml && textPart) || htmlToPlainText(message.bodyHtml || '');
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  let quotedFrom = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (
      /^On .{5,120} wrote:\s*$/.test(l) ||
      /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(l) ||
      /^_{8,}\s*$/.test(l) ||
      l.startsWith('>')
    ) {
      quotedFrom = i;
      break;
    }
    kept.push(lines[i]);
  }
  const result = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  let quoted =
    quotedFrom >= 0
      ? lines.slice(quotedFrom).join('\n').replace(/\n{3,}/g, '\n\n').trim()
      : '';
  // When the quote came from the plain-text part it can still carry raw HTML
  // (e.g. a mobile client that pasted our HTML notification into the text
  // body). Only clean it when it actually looks like markup, so plaintext
  // quotes that legitimately contain <email@addr> aren't mangled.
  if (quoted && /<\/?[a-z][^>]*>/i.test(quoted)) {
    quoted = htmlToPlainText(quoted).replace(/\n{3,}/g, '\n\n').trim();
  }
  const rawTrimmed = raw.trim();

  // Detect a forward and show the full body so the forwarded message is never
  // hidden. Two signals: the subject starts with Fwd:/FW:, or the body has a
  // forwarded-message separator and almost nothing survived stripping (a thin
  // "see below" intro). A normal reply that merely quotes a forward keeps its
  // own text, so its stripped result stays long and we don't over-show.
  const subjectIsForward = /^\s*(fwd?|fw)\s*:/i.test(message.subject || '');
  const bodyHasForwardMarker =
    /^[-_]{2,}\s*forwarded message\s*[-_]{2,}/im.test(raw) ||
    /^begin forwarded message:/im.test(raw);
  const isForward =
    subjectIsForward || (bodyHasForwardMarker && result.length < 60);
  if (isForward && rawTrimmed.length > result.length) {
    return { reply: rawTrimmed, quoted: '' };
  }

  // Only expose a quoted block when there's a real reply in front of it;
  // otherwise the whole body IS the content and goes in the bubble.
  return { reply: result || rawTrimmed, quoted: result ? quoted : '' };
}

function linkifyText(text: string): React.ReactNode[] {
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g;
  const parts = text.split(urlRegex);

  return parts.map((part, index) => {
    if (urlRegex.test(part)) {
      // Reset regex lastIndex since we're reusing it
      urlRegex.lastIndex = 0;
      return (
        <a
          key={index}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="underline break-all font-medium"
        >
          {(() => {
            try {
              const u = new URL(part);
              const label =
                u.hostname.replace(/^www\./, '') +
                (u.pathname.length > 1 ? u.pathname : '');
              return label.length > 50 ? label.slice(0, 47) + '...' : label;
            } catch {
              return part.slice(0, 47) + '...';
            }
          })()}
        </a>
      );
    }
    return part;
  });
}

// Type for cached threads data
interface CachedThread {
  id: string;
  status: string;
}

// The inbox list now uses useInfiniteQuery, so ['threads'] cache entries can
// be either the flat { threads } shape (related-threads etc.) or the infinite
// { pages: [{ threads }] } shape. These helpers read/patch both.
interface ThreadsPage {
  threads?: CachedThread[];
}
type ThreadsCacheData =
  | (ThreadsPage & { pages?: undefined })
  | { pages: ThreadsPage[]; pageParams?: unknown[] };

function threadsFromCache(data: ThreadsCacheData | undefined): CachedThread[] {
  if (!data) return [];
  if ('pages' in data && data.pages) {
    return data.pages.flatMap((p) => p.threads || []);
  }
  return (data as ThreadsPage).threads || [];
}

function mapThreadsCache(
  data: ThreadsCacheData | undefined,
  fn: (threads: CachedThread[]) => CachedThread[]
): ThreadsCacheData | undefined {
  if (!data) return data;
  if ('pages' in data && data.pages) {
    return {
      ...data,
      pages: data.pages.map((p) =>
        p.threads ? { ...p, threads: fn(p.threads) } : p
      ),
    };
  }
  const flat = data as ThreadsPage;
  if (!flat.threads) return data;
  return { ...flat, threads: fn(flat.threads) };
}

/** Flip a thread's status across every cached threads list (both shapes). */
function setThreadStatusInCaches(
  queryClient: QueryClient,
  threadId: string,
  status: string
) {
  queryClient.setQueriesData<ThreadsCacheData>({ queryKey: ['threads'] }, (data) =>
    mapThreadsCache(data, (threads) =>
      threads.map((t) => (t.id === threadId ? { ...t, status } : t))
    )
  );
  queryClient.setQueryData<ThreadsCacheData>(['threads-open'], (data) =>
    mapThreadsCache(data, (threads) =>
      threads.map((t) => (t.id === threadId ? { ...t, status } : t))
    )
  );
}

// ---------------------------------------------------------------------------
// Background send queue (Send & Close)
//
// The operator moves to the next email immediately; the actual SMTP round-trip
// runs back here, serialized so rapid-fire sends can't race each other (same
// pattern as the social comment action queue). On failure the thread status is
// restored, the unsent reply goes back into the per-thread draft store, and a
// persistent banner (rendered by the inbox list) names the affected thread.
// Module-level so an unmounting ThreadView can't orphan the completion logic.
// ---------------------------------------------------------------------------
let sendChain: Promise<unknown> = Promise.resolve();

function queueBackgroundSend(args: {
  queryClient: QueryClient;
  threadId: string;
  subject: string;
  html: string;
  files: File[];
  originalSuggestion: string | null;
}) {
  const { queryClient, threadId, subject, html, files, originalSuggestion } = args;

  // Idempotency key: the server stores it on the message, so if a first
  // attempt actually sent but the response was lost (proxy error during a
  // deploy, connection timeout), the retry replays the outcome instead of
  // emailing the customer twice.
  const clientSendId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const run = sendChain.then(async () => {
    const attempt = async () => {
      const formData = new FormData();
      formData.append('bodyHtml', html);
      formData.append('closeOnSend', 'true');
      formData.append('clientSendId', clientSendId);
      if (originalSuggestion) {
        formData.append('originalSuggestion', originalSuggestion);
      }
      for (const file of files) {
        formData.append('attachments', file);
      }

      const res = await fetch(`/api/threads/${threadId}/messages`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const parsed = (await res.json().catch(() => null)) as {
          error?: string;
          details?: string;
        } | null;
        const err = new Error(
          parsed?.details || parsed?.error || 'Failed to send message'
        ) as Error & { retriable?: boolean };
        // Non-JSON response = the request never reached the app (Railway
        // edge during a container swap). Timeouts are connect-phase and
        // idempotency-protected either way.
        err.retriable =
          !parsed || /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(err.message);
        throw err;
      }
      return res.json();
    };

    try {
      return await attempt();
    } catch (e) {
      const err = e as Error & { retriable?: boolean };
      // One automatic retry for transient failures - safe because the
      // clientSendId makes the server replay, never double-send.
      if (err.retriable || err instanceof TypeError) {
        await new Promise((r) => setTimeout(r, 20_000));
        return attempt();
      }
      throw e;
    }
  });
  // Keep the chain alive even if this send rejects, so one failure can't
  // stall every queued send behind it.
  sendChain = run.catch(() => undefined);

  run
    .then(() => {
      queryClient.invalidateQueries({ queryKey: ['thread', threadId] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
    })
    .catch((err: Error) => {
      // Nothing was sent or closed server-side - restore the reply into the
      // draft store, revert the optimistic close, and surface the failure.
      setReplyDraft(threadId, html);
      setThreadStatusInCaches(queryClient, threadId, 'OPEN');
      queryClient.invalidateQueries({ queryKey: ['thread', threadId] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
      addSendError({
        threadId,
        subject,
        message: err.message || 'Failed to send message',
      });
    });
}

// Wrap quoted text in collapsible sections
function wrapQuotedText(html: string): string {
  // Pattern 1: Gmail-style div with gmail_quote class (greedy to capture all nested content)
  const gmailPattern = /(<div[^>]*class="[^"]*gmail_quote[^"]*"[^>]*>[\s\S]*<\/div>)\s*$/gi;

  // Pattern 2: "On [date], [name] wrote:" and everything after (captures to end of string)
  const wrotePattern = /((?:<div[^>]*>)?On\s+[^<]*wrote:[\s\S]*)$/i;

  // Pattern 3: Outlook-style "From:" header quote block
  const outlookPattern = /((?:<div[^>]*>)?-{3,}.*?(?:Original Message|Forwarded message).*?-{3,}[\s\S]*)$/i;

  // Pattern 4: Blockquote elements (greedy)
  const blockquotePattern = /(<blockquote[^>]*>[\s\S]*<\/blockquote>)/gi;

  const wrapWithToggle = (match: string) => {
    return `<details class="quoted-text-wrapper">
      <summary class="quoted-text-toggle"><span class="when-closed">••• Show quoted text</span><span class="when-open">▾ Hide quoted text</span></summary>
      <div class="quoted-text-content">${match}</div>
    </details>`;
  };

  let result = html;
  let wrapped = false;

  // Try Gmail-style quotes first
  if (gmailPattern.test(result)) {
    result = result.replace(gmailPattern, wrapWithToggle);
    wrapped = true;
  }

  // Try "wrote:" pattern
  if (!wrapped && wrotePattern.test(result)) {
    result = result.replace(wrotePattern, wrapWithToggle);
    wrapped = true;
  }

  // Try Outlook-style pattern
  if (!wrapped && outlookPattern.test(result)) {
    result = result.replace(outlookPattern, wrapWithToggle);
    wrapped = true;
  }

  // Try blockquotes
  if (!wrapped && blockquotePattern.test(result)) {
    result = result.replace(blockquotePattern, wrapWithToggle);
  }

  return result;
}

function renderMessageHtml(
  message: Message,
  attachmentData: Record<string, string>
) {
  if (!message.bodyHtml) {
    return null;
  }

  let html = message.bodyHtml;

  // Replace CID references with base64 data URLs
  for (const att of message.attachments || []) {
    if (!att.contentId) continue;
    const cid = att.contentId.replace(/^<|>$/g, '');
    // Use pre-fetched base64 data or fall back to API URL
    const dataUrl = attachmentData[att.id] || attachmentData[cid];
    const url = dataUrl || `/api/attachments/${att.id}`;
    html = html
      .replaceAll(`cid:${cid}`, url)
      .replaceAll(`cid:<${cid}>`, url);
  }

  // Defense-in-depth scrubbing only. The real security boundary is the
  // iframe sandbox (no allow-scripts / allow-same-origin), which blocks
  // execution of anything these regexes miss.
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  html = html.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, ''); // onclick, onerror, etc.
  html = html.replace(/\s+on\w+\s*=\s*[^\s>]+/gi, ''); // unquoted handler values
  // javascript:/vbscript:/data: URLs in links (tolerate whitespace/entity obfuscation)
  html = html.replace(
    /\s+(href|src)\s*=\s*(["']?)\s*(?:javascript\s*:|vbscript\s*:|data\s*:\s*text\/html)[^"'\s>]*\2/gi,
    ' $1="#"'
  );

  // Strip outer HTML structure from email (we provide our own wrapper)
  // This prevents xmlns attributes from Outlook emails appearing as text
  html = html.replace(/<!DOCTYPE[^>]*>/gi, '');
  html = html.replace(/<html[^>]*>/gi, '');
  html = html.replace(/<\/html>/gi, '');
  html = html.replace(/<head[\s\S]*?<\/head>/gi, '');
  html = html.replace(/<body[^>]*>/gi, '');
  html = html.replace(/<\/body>/gi, '');

  // Convert plain text URLs to clickable links (only if not already in an anchor tag)
  // Two-pass approach: first mark existing links, then linkify unmarked URLs
  // This avoids the complex lookbehind issues with URLs inside href attributes
  const linkPlaceholder = '___LINK_PLACEHOLDER___';

  // Temporarily replace existing anchor tags to protect them
  const existingLinks: string[] = [];
  html = html.replace(/<a\s[^>]*>[\s\S]*?<\/a>/gi, (match) => {
    existingLinks.push(match);
    return `${linkPlaceholder}${existingLinks.length - 1}${linkPlaceholder}`;
  });

  // Now safely linkify any remaining plain URLs
  html = html.replace(
    /(https?:\/\/[^\s<>"']+)/gi,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // Restore the original anchor tags
  html = html.replace(new RegExp(`${linkPlaceholder}(\\d+)${linkPlaceholder}`, 'g'), (_, index) => {
    return existingLinks[parseInt(index, 10)] || '';
  });

  // Email rendering - preserve original email styling like Gmail/Outlook
  // Key principle: minimal interference, let email's own CSS work
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<base target="_blank" />
<style>
  /* Minimal reset - don't override email styles */
  html {
    margin: 0;
    padding: 0;
  }
  body {
    margin: 0;
    padding: 16px;
    background: white;
    /* Only set defaults if email doesn't specify - using lower specificity */
    font-family: Arial, Helvetica, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: #222;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  /* Preserve table-based email layouts (used by most marketing emails) */
  table {
    border-collapse: collapse;
    mso-table-lspace: 0pt;
    mso-table-rspace: 0pt;
  }
  td, th {
    vertical-align: top;
  }

  /* Images - respect width/height attributes, scale proportionally */
  img {
    border: 0;
    height: auto;
    outline: none;
    text-decoration: none;
    -ms-interpolation-mode: bicubic;
    max-width: 100%;
  }
  /* Respect explicit image dimensions from HTML attributes */
  img[width] {
    width: auto;
    max-width: 100%;
  }
  img[style*="width"] {
    max-width: 100%;
  }

  /* Paragraphs and divs - normalize spacing like Gmail */
  p {
    margin: 0 0 1em 0;
  }
  p:last-child {
    margin-bottom: 0;
  }
  div {
    /* Don't add margins to divs - they're often used as wrappers */
  }

  /* Lists - proper indentation and spacing */
  ul, ol {
    margin: 0.5em 0;
    padding-left: 2em;
  }
  li {
    margin: 0.25em 0;
  }

  /* Headings - reasonable defaults */
  h1, h2, h3, h4, h5, h6 {
    margin: 0.5em 0;
    line-height: 1.3;
    font-weight: bold;
  }
  h1 { font-size: 1.5em; }
  h2 { font-size: 1.3em; }
  h3 { font-size: 1.1em; }

  /* Horizontal rules */
  hr {
    border: none;
    border-top: 1px solid #ccc;
    margin: 1em 0;
  }

  /* Center tag (used in older emails) */
  center {
    text-align: center;
  }

  /* Prevent wide content from breaking layout */
  * {
    max-width: 100%;
    box-sizing: border-box;
  }
  table, td, th {
    max-width: none; /* Tables handle their own width */
  }

  /* Links - only underline actual links with real URLs */
  a {
    color: inherit;
    text-decoration: none;
  }
  a[href^="http"], a[href^="mailto:"], a[href^="tel:"] {
    color: #2563eb;
    text-decoration: underline;
    cursor: pointer;
  }
  a[href^="http"]:hover, a[href^="mailto:"]:hover, a[href^="tel:"]:hover {
    color: #1d4ed8;
    text-decoration: none;
  }

  /* Blockquotes for email replies */
  blockquote {
    margin: 0.5em 0;
    padding-left: 1em;
    border-left: 2px solid #ccc;
    color: inherit;
  }

  /* Preserve preformatted text */
  pre, code {
    white-space: pre-wrap;
    word-wrap: break-word;
    font-family: monospace;
  }

  /* Gmail-style quoted text handling */
  .gmail_quote, .yahoo_quoted, blockquote[type="cite"] {
    margin: 0.5em 0;
    padding-left: 1em;
    border-left: 2px solid #ccc;
  }

  /* Quoted text collapsing - pure HTML details/summary, no scripts
     (the iframe sandbox blocks all script execution) */
  .quoted-text-wrapper {
    margin-top: 1em;
  }
  .quoted-text-content {
    margin-top: 0.5em;
  }
  .quoted-text-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    font-size: 12px;
    color: #666;
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
    border-radius: 4px;
    cursor: pointer;
    user-select: none;
    list-style: none;
  }
  .quoted-text-toggle::-webkit-details-marker {
    display: none;
  }
  .quoted-text-toggle:hover {
    background: #e5e7eb;
    color: #374151;
  }
  .quoted-text-toggle .when-open {
    display: none;
  }
  details[open] > .quoted-text-toggle .when-closed {
    display: none;
  }
  details[open] > .quoted-text-toggle .when-open {
    display: inline;
  }
</style>
</head>
<body>${wrapQuotedText(html)}</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Message list - memoized so composer/query re-renders in ThreadView never
// re-render the (potentially long) conversation, and per-message work
// (splitReply regex, iframe srcDoc building) is memoized per message.
// ---------------------------------------------------------------------------
interface MessageBubbleProps {
  message: Message;
  prevSentAt: string | null;
  showOriginal: boolean;
  onToggleOriginal: (messageId: string) => void;
  attachmentData: Record<string, string>;
}

const MessageBubble = memo(function MessageBubble({
  message,
  prevSentAt,
  showOriginal,
  onToggleOriginal,
  attachmentData,
}: MessageBubbleProps) {
  const isOutbound = message.direction === 'OUTBOUND';
  const newDay =
    !prevSentAt ||
    new Date(prevSentAt).toDateString() !==
      new Date(message.sentAt).toDateString();

  // The quote-splitting regexes only need to run when the message itself
  // changes, not on every list render.
  const { reply: text, quoted } = useMemo(() => splitReply(message), [message]);

  // Building the iframe srcDoc walks and rewrites the whole email HTML -
  // only do it when the original view is actually shown.
  const srcDoc = useMemo(
    () =>
      showOriginal && message.bodyHtml
        ? renderMessageHtml(message, attachmentData)
        : null,
    [showOriginal, message, attachmentData]
  );

  const displayName = isOutbound
    ? 'Me'
    : message.fromName || message.fromAddress;

  const imageAttachments = message.attachments.filter(
    (att) => att.mimeType?.startsWith('image/') && !att.contentId
  );

  return (
    <div>
      {newDay && (
        <div className="flex items-center gap-3 my-1">
          <div className="flex-1 h-px bg-gray-200" />
          <span className="text-xs text-gray-400">
            {new Date(message.sentAt).toLocaleDateString([], {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
            })}
          </span>
          <div className="flex-1 h-px bg-gray-200" />
        </div>
      )}
      <div
        className={cn(
          'flex gap-2 mb-1',
          isOutbound ? 'justify-end' : 'justify-start'
        )}
      >
        {!isOutbound && (
          <Avatar
            name={message.fromName || message.fromAddress}
            size="sm"
            className="mt-1 flex-shrink-0"
          />
        )}
        <div className={cn('min-w-0', showOriginal ? 'w-[92%]' : 'max-w-[75%]')}>
          {showOriginal && srcDoc ? (
            <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
              {/* Untrusted customer HTML. The sandbox must never include
                  allow-scripts or allow-same-origin: either would let a
                  payload that survives sanitization run with (or reach) the
                  operator's session. Without same-origin we can't measure
                  the content, so the frame gets a fixed height and scrolls
                  internally. */}
              <iframe
                title={`message-${message.id}`}
                className="w-full border-0"
                style={{ height: 'min(65vh, 720px)' }}
                sandbox="allow-popups allow-popups-to-escape-sandbox"
                srcDoc={srcDoc}
              />
            </div>
          ) : (
            <div
              className={cn(
                'rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words leading-relaxed',
                isOutbound
                  ? 'bg-blue-600 text-white rounded-br-sm [&_a]:text-blue-100'
                  : 'bg-gray-100 text-gray-900 rounded-bl-sm [&_a]:text-blue-600'
              )}
            >
              {linkifyText(text)}
            </div>
          )}

          {/* The email the customer replied to (quoted history). Hidden
              by default, one click away - so a reply to one of our
              shipping/order emails always shows what it answers. */}
          {!showOriginal && quoted && (
            <details className={cn('mt-1', isOutbound && 'text-right')}>
              <summary className="cursor-pointer select-none text-xs text-gray-400 hover:text-gray-600">
                Show quoted email
              </summary>
              <div className="mt-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500 whitespace-pre-wrap break-words leading-relaxed text-left">
                {linkifyText(quoted)}
              </div>
            </details>
          )}

          {/* Attachments under the bubble */}
          {message.attachments.length > 0 && (
            <div className={cn('mt-1.5', isOutbound && 'flex flex-col items-end')}>
              {imageAttachments.length > 0 && (
                <div className={cn('flex flex-wrap gap-2 mb-1.5', isOutbound && 'justify-end')}>
                  {imageAttachments.map((att) => {
                    const src =
                      attachmentData[att.id] || `/api/attachments/${att.id}`;
                    return (
                      <a
                        key={att.id}
                        href={`/api/attachments/${att.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block"
                      >
                        <img
                          src={src}
                          alt={att.filename}
                          className="max-h-40 max-w-full rounded-lg border border-gray-200 hover:border-blue-400 transition-colors"
                        />
                      </a>
                    );
                  })}
                </div>
              )}
              <div className={cn('flex flex-wrap gap-1.5', isOutbound && 'justify-end')}>
                {message.attachments.map((att) => (
                  <a
                    key={att.id}
                    href={`/api/attachments/${att.id}?download`}
                    download={att.filename}
                    className="inline-flex items-center gap-1 text-xs bg-white hover:bg-gray-100 px-2 py-1 rounded-full border border-gray-200 text-gray-600 hover:text-gray-900 transition-colors"
                  >
                    <Paperclip className="w-3 h-3" />
                    {att.filename}
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Meta row: name, time, original toggle */}
          <div
            className={cn(
              'flex items-center gap-2 mt-1 text-[11px] text-gray-400',
              isOutbound && 'justify-end'
            )}
          >
            {!isOutbound && !message.isRead && (
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
            )}
            <span className={cn(!isOutbound && !message.isRead && 'font-semibold text-gray-600')}>
              {displayName}
            </span>
            <span className="cursor-help" title={formatDateFull(message.sentAt)}>
              {formatDateRelative(message.sentAt)}
            </span>
            {message.bodyHtml && (
              <button
                onClick={() => onToggleOriginal(message.id)}
                className="hover:text-blue-600 underline-offset-2 hover:underline"
              >
                {showOriginal ? 'Hide original' : 'Original email'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

interface MessageListProps {
  messages: Message[];
  expandedIds: Set<string>;
  onToggleOriginal: (messageId: string) => void;
  attachmentData: Record<string, string>;
}

const MessageList = memo(function MessageList({
  messages,
  expandedIds,
  onToggleOriginal,
  attachmentData,
}: MessageListProps) {
  return (
    <div className="space-y-0.5">
      {messages.map((message, index) => (
        <MessageBubble
          key={message.id}
          message={message}
          prevSentAt={index > 0 ? messages[index - 1].sentAt : null}
          showOriginal={expandedIds.has(message.id)}
          onToggleOriginal={onToggleOriginal}
          attachmentData={attachmentData}
        />
      ))}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Reply composer - owns the TipTap editor, its content, and the attachment
// picker. Content lives in a ref (plus the per-thread draft store), NOT in
// ThreadView state, so a keystroke never re-renders the whole thread view.
// The parent talks to it through an imperative handle for the rare
// programmatic changes (AI draft load, canned insert, refine, clear).
// ---------------------------------------------------------------------------
/** TipTap's "empty" is `<p></p>` - treat content as real only when text or
 *  an inline image survives stripping the markup. */
function hasMeaningfulContent(html: string): boolean {
  return (
    !!html.replace(/<br\s*\/?>/gi, '').replace(/<[^>]*>/g, '').trim() ||
    /<img\b/i.test(html)
  );
}

export interface ReplyComposerHandle {
  getHtml: () => string;
  /** Replace the content. persist=true also records it as a local draft. */
  setHtml: (html: string, opts?: { persist?: boolean }) => void;
  /** Append below existing content (canned replies). Persists as a draft. */
  appendHtml: (html: string) => void;
  getFiles: () => File[];
  clear: () => void;
  focus: () => void;
}

interface ReplyComposerProps {
  threadId: string;
  disabled: boolean;
  customerEmail: string;
  sendPending: boolean;
  onSend: (html: string, files: File[]) => void;
  onSendAndClose: (html: string, files: File[]) => void;
  onHasContentChange: (hasContent: boolean) => void;
}

const ReplyComposer = memo(
  forwardRef<ReplyComposerHandle, ReplyComposerProps>(function ReplyComposer(
    {
      threadId,
      disabled,
      customerEmail,
      sendPending,
      onSend,
      onSendAndClose,
      onHasContentChange,
    },
    ref
  ) {
    // Seed the editor with any locally saved draft for this thread. The
    // composer is keyed by threadId in the parent, so this initializer runs
    // fresh on every thread switch.
    const [seed, setSeed] = useState<{ html: string; nonce: number }>(() => ({
      html: getReplyDraft(threadId),
      nonce: 0,
    }));
    const htmlRef = useRef(seed.html);
    const [hasContent, setHasContent] = useState(() =>
      hasMeaningfulContent(seed.html)
    );
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const updateHasContent = useCallback(
      (html: string) => {
        const has = hasMeaningfulContent(html);
        setHasContent((prev) => {
          if (prev !== has) onHasContentChange(has);
          return has;
        });
      },
      [onHasContentChange]
    );

    // User keystrokes: update the ref + draft store only - no re-render.
    // Empty markup (TipTap's `<p></p>`) clears the stored draft instead of
    // shadowing the server AI draft with nothing.
    const handleEditorChange = useCallback(
      (html: string) => {
        htmlRef.current = html;
        if (hasMeaningfulContent(html)) setReplyDraft(threadId, html);
        else clearReplyDraft(threadId);
        updateHasContent(html);
      },
      [threadId, updateHasContent]
    );

    const setHtml = useCallback(
      (html: string, opts?: { persist?: boolean }) => {
        htmlRef.current = html;
        // Bump the nonce so the editor remounts with the new content even if
        // the seed string happens to match a previous programmatic value.
        setSeed((prev) => ({ html, nonce: prev.nonce + 1 }));
        if (opts?.persist) setReplyDraft(threadId, html);
        updateHasContent(html);
      },
      [threadId, updateHasContent]
    );

    useImperativeHandle(
      ref,
      () => ({
        getHtml: () => htmlRef.current,
        setHtml,
        appendHtml: (html: string) => {
          const prev = htmlRef.current;
          const next = prev.trim() ? `${prev}<br/><br/>${html}` : html;
          htmlRef.current = next;
          setSeed((s) => ({ html: next, nonce: s.nonce + 1 }));
          setReplyDraft(threadId, next);
          updateHasContent(next);
        },
        getFiles: () => selectedFiles,
        clear: () => {
          htmlRef.current = '';
          setSeed((s) => ({ html: '', nonce: s.nonce + 1 }));
          setSelectedFiles([]);
          clearReplyDraft(threadId);
          updateHasContent('');
        },
        focus: () => {
          const editorEl =
            containerRef.current?.querySelector<HTMLElement>('.ProseMirror');
          editorEl?.focus();
        },
      }),
      [threadId, setHtml, selectedFiles, updateHasContent]
    );

    const canSend = hasContent && !sendPending && !disabled;

    return (
      <div
        ref={containerRef}
        className="border rounded-lg overflow-hidden"
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter = Send & Close (the fast path)
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            if (canSend) {
              onSendAndClose(htmlRef.current, selectedFiles);
            }
          }
        }}
      >
        <RichTextEditor
          key={`${threadId}:${seed.nonce}`}
          value={seed.html}
          onChange={handleEditorChange}
          placeholder="Type your reply..."
          disabled={disabled}
          className="border-0 rounded-none"
        />

        {/* Selected attachments */}
        {selectedFiles.length > 0 && (
          <div className="px-3 py-2 border-t bg-gray-50 flex flex-wrap gap-2">
            {selectedFiles.map((file, index) => (
              <div
                key={`${file.name}-${index}`}
                className="inline-flex items-center gap-1 text-xs bg-white border border-gray-200 px-2 py-1.5 rounded"
              >
                {file.type.startsWith('image/') ? (
                  <Image className="w-3 h-3 text-gray-500" />
                ) : (
                  <FileText className="w-3 h-3 text-gray-500" />
                )}
                <span className="text-gray-700 max-w-[150px] truncate">
                  {file.name}
                </span>
                <span className="text-gray-400">
                  ({Math.round(file.size / 1024)}KB)
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedFiles((prev) =>
                      prev.filter((_, i) => i !== index)
                    )
                  }
                  className="ml-1 text-gray-400 hover:text-red-500"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between px-3 py-2 border-t bg-gray-50">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">
              Replying to {customerEmail}
            </span>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                setSelectedFiles((prev) => [...prev, ...files]);
                e.target.value = ''; // Reset input
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
            >
              <Paperclip className="w-4 h-4" />
              Attach
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onSend(htmlRef.current, selectedFiles)}
              disabled={!canSend}
              loading={sendPending}
            >
              <Send className="w-4 h-4 mr-1" />
              Send
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => onSendAndClose(htmlRef.current, selectedFiles)}
              disabled={!canSend}
              title="Send reply, close thread, jump to the next open email (Cmd+Enter). The send runs in the background."
            >
              <Send className="w-4 h-4 mr-1" />
              Send &amp; Close
            </Button>
          </div>
        </div>
      </div>
    );
  })
);

export function ThreadView({ threadId, onThreadDeleted, onSelectThread }: ThreadViewProps) {
  const queryClient = useQueryClient();
  // Live view of which thread is on screen RIGHT NOW - refs never go stale.
  // The July-1 cross-thread guard compared against the render-closure
  // threadId, which can lag under some render timings; a late AI response
  // still leaked into another thread's composer (Patricia/Liz, 2026-07-10).
  const activeThreadIdRef = useRef(threadId);
  activeThreadIdRef.current = threadId;
  const composerRef = useRef<ReplyComposerHandle>(null);
  // Whether the composer currently has content - flips rarely (empty <->
  // non-empty), used by banners and the Edit-with-AI button. The content
  // itself never lives in ThreadView state (see ReplyComposer).
  const [hasReplyContent, setHasReplyContent] = useState(false);
  const [showAssigneeMenu, setShowAssigneeMenu] = useState(false);
  const assigneeMenuRef = useRef<HTMLDivElement | null>(null);
  const [showCannedMenu, setShowCannedMenu] = useState(false);
  const cannedMenuRef = useRef<HTMLDivElement | null>(null);

  // Canned replies (macros) for one-click FAQ inserts
  const { data: cannedData } = useQuery<{
    replies: { id: string; title: string; category: string | null; body: string }[];
  }>({
    queryKey: ['canned-replies'],
    queryFn: async () => {
      const res = await fetch('/api/canned-replies');
      if (!res.ok) return { replies: [] };
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
  const cannedReplies = cannedData?.replies || [];

  const insertCannedReply = (bodyText: string) => {
    const html = bodyText.replace(/\n/g, '<br/>');
    composerRef.current?.appendHtml(html);
    setShowCannedMenu(false);
  };

  // Navigate to the NEXT open thread after the current one (preserving inbox
  // order), falling back to the previous open one, then any open one.
  const navigateToNextOpenThread = useCallback((): boolean => {
    const openCache = queryClient.getQueryData<{ threads: CachedThread[] }>([
      'threads-open',
    ]);

    // Build the ordered thread list (dedup, preserving first-seen order).
    let ordered: CachedThread[] = openCache?.threads || [];
    if (ordered.length === 0) {
      const seen = new Set<string>();
      ordered = queryClient
        .getQueriesData<ThreadsCacheData>({ queryKey: ['threads'] })
        .flatMap(([, data]) => threadsFromCache(data))
        .filter((t) => {
          if (seen.has(t.id)) return false;
          seen.add(t.id);
          return true;
        });
    }

    const isOpen = (t: CachedThread) =>
      t.id !== threadId && (t.status === 'OPEN' || t.status === 'PENDING');

    const currentIdx = ordered.findIndex((t) => t.id === threadId);
    let next: CachedThread | undefined;
    if (currentIdx >= 0) {
      // The next open thread AFTER the one we just closed.
      next = ordered.slice(currentIdx + 1).find(isOpen);
      // Otherwise the nearest open thread BEFORE it.
      if (!next) {
        next = [...ordered.slice(0, currentIdx)].reverse().find(isOpen);
      }
    }
    // Fallback: any open thread.
    if (!next) next = ordered.find(isOpen);

    if (next && onSelectThread) {
      onSelectThread(next.id);
      return true;
    }

    // No more open threads - clear selection
    onThreadDeleted?.();
    return false;
  }, [queryClient, threadId, onSelectThread, onThreadDeleted]);

  // The sidebar's one-click exchange approval sends + closes from outside
  // this component - advance to the next open email just like Send & Close.
  useEffect(() => {
    const onExternallyClosed = (e: Event) => {
      const detail = (e as CustomEvent).detail as { threadId?: string } | undefined;
      if (detail?.threadId !== threadId) return;
      navigateToNextOpenThread();
    };
    window.addEventListener('ss:thread-closed', onExternallyClosed);
    return () => window.removeEventListener('ss:thread-closed', onExternallyClosed);
  }, [threadId, navigateToNextOpenThread]);
  const [attachmentData, setAttachmentData] = useState<Record<string, string>>({});

  const [showRelatedThreads, setShowRelatedThreads] = useState(false);
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const tagMenuRef = useRef<HTMLDivElement | null>(null);
  const [hoveredThread, setHoveredThread] = useState<string | null>(null);
  // Track which messages are manually expanded (older messages start collapsed)
  const [manuallyExpandedMessages, setManuallyExpandedMessages] = useState<Set<string>>(new Set());
  const [suggestionWarnings, setSuggestionWarnings] = useState<string[]>([]);
  // Draft-check list visibility - collapsed by default, reset per thread
  const [showWarnings, setShowWarnings] = useState(false);
  useEffect(() => {
    setShowWarnings(false);
  }, [threadId]);
  const [originalSuggestion, setOriginalSuggestion] = useState<string | null>(null);
  // Brand-lint: a send that trips a hard brand rule is parked here and the
  // operator must explicitly "Send anyway" (warn, never block).
  const [lintWarnings, setLintWarnings] = useState<ReplyLintWarning[]>([]);
  const [pendingSend, setPendingSend] = useState<{
    html: string;
    files: File[];
    mode: 'plain' | 'close';
  } | null>(null);
  // Escalation banner state (agents only)
  const [escalated, setEscalated] = useState(false);
  const [escalating, setEscalating] = useState(false);
  useEffect(() => {
    setLintWarnings([]);
    setPendingSend(null);
    setEscalated(false);
  }, [threadId]);
  const { data: viewerSession } = useSession();
  const viewerRole = (viewerSession?.user as { role?: string } | undefined)?.role;
  const [refineInstructions, setRefineInstructions] = useState('');
  const [showRefineInput, setShowRefineInput] = useState(false);
  // "What the AI saw": the exact facts block the draft model received
  const [showAiContext, setShowAiContext] = useState(false);
  const [aiContextLoading, setAiContextLoading] = useState(false);
  const [aiContext, setAiContext] = useState<{
    facts: string;
    orderCount: number;
    messageCount: number;
    matchedOrder: string | null;
    ambiguousOrder: boolean;
  } | null>(null);

  const loadAiContext = useCallback(async () => {
    setAiContextLoading(true);
    try {
      const res = await fetch(`/api/threads/${threadId}/ai-context`);
      if (res.ok) setAiContext(await res.json());
    } catch {
      // best-effort review aid
    } finally {
      setAiContextLoading(false);
    }
  }, [threadId]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);


  // Reset state when switching threads. The composer itself is keyed by
  // threadId (it remounts and restores any local draft on its own) - only
  // mirror whether a saved draft exists so banners/buttons start correct.
  useEffect(() => {
    setHasReplyContent(hasMeaningfulContent(getReplyDraft(threadId)));
    setShowRelatedThreads(false);
    setShowTagDropdown(false);
    setShowAssigneeMenu(false);
    setSuggestionWarnings([]);
    setOriginalSuggestion(null);
    setRefineInstructions('');
    setShowAiContext(false);
    setAiContext(null);
    setShowRefineInput(false);
    setManuallyExpandedMessages(new Set()); // Reset expanded messages
    setHoveredThread(null);
  }, [threadId]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (
        showAssigneeMenu &&
        assigneeMenuRef.current &&
        target &&
        !assigneeMenuRef.current.contains(target)
      ) {
        setShowAssigneeMenu(false);
      }
      if (
        showCannedMenu &&
        cannedMenuRef.current &&
        target &&
        !cannedMenuRef.current.contains(target)
      ) {
        setShowCannedMenu(false);
      }
      if (
        showTagDropdown &&
        tagMenuRef.current &&
        target &&
        !tagMenuRef.current.contains(target)
      ) {
        setShowTagDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showAssigneeMenu, showCannedMenu, showTagDropdown]);

  const { data: thread, isLoading } = useQuery<Thread>({
    queryKey: ['thread', threadId],
    queryFn: async () => {
      const res = await fetch(`/api/threads/${threadId}`);
      if (!res.ok) throw new Error('Failed to fetch thread');
      return res.json();
    },
    // Switching back to a recently read thread renders from cache instantly;
    // invalidations (send, status changes, read-marking) still force fresh
    // data when something actually changed.
    staleTime: 20_000,
    // While a draft is being prepared (or held for an action), poll so the
    // finished draft appears on its own.
    refetchInterval: (query) => {
      const status = query.state.data?.aiDraft?.status;
      return status === 'PENDING' || status === 'STALE' || status === 'AWAITING_ACTION'
        ? 8000
        : false;
    },
  });

  // Auto-load the pre-generated AI draft into the composer when the thread
  // opens with an empty editor (the background worker prepared it already).
  // A local edit saved for this thread always wins over the server draft.
  useEffect(() => {
    const draft = thread?.aiDraft;
    // The draft must belong to the thread on screen - never seed the composer
    // from another thread's cached data, whatever the query layer served.
    if (thread && thread.id && thread.id !== threadId) return;
    if (!draft || draft.status !== 'READY' || !draft.body) return;
    if (hasReplyContent) return; // never clobber what the agent typed
    if (hasMeaningfulContent(getReplyDraft(threadId))) return; // local edit wins
    if (hasMeaningfulContent(composerRef.current?.getHtml() || '')) return;
    if (thread?.status === 'TRASHED') return;

    // persist:false - the server draft is not a "local edit"; a fresh one
    // will simply load again next time the thread opens empty.
    composerRef.current?.setHtml(draft.body.replace(/\n/g, '<br/>'), {
      persist: false,
    });
    setOriginalSuggestion(draft.body);
    setSuggestionWarnings((draft.warnings as string[] | null) || []);
  }, [thread?.aiDraft, thread?.status, threadId, hasReplyContent]);

  // Which action tab (if any) this thread gets, mirroring the sidebar's
  // actionable-intent set. Defaults active so the suggested action is the
  // first thing under the conversation, like a helpdesk ticket.
  const ACTION_TAB_INTENTS: Record<string, string> = {
    SIZE_EXCHANGE: 'Size exchange',
    SHIPPING_STATUS: 'Shipping status',
    ADDRESS_UPDATE: 'Address update',
    CANCELLATION: 'Cancellation',
    UNSUBSCRIBE: 'Unsubscribe',
  };
  // Safety net: surface the Unsubscribe action when the latest inbound message
  // is an obvious opt-out, even if the stored intent says otherwise (e.g. a
  // thread classified before the UNSUBSCRIBE intent existed).
  const latestInboundMsg = [...(thread?.messages || [])]
    .reverse()
    .find((m) => m.direction === 'INBOUND');
  const looksLikeUnsub = isUnsubscribeText(plainTextFromMessage(latestInboundMsg));

  // Escalation lane (agents only): on high-risk threads the composer shows a
  // "hand this to Pati" banner so a VA has an obvious out instead of talking
  // themselves into sending. Flags the thread into Needs Attention.
  const escalationReason = useMemo(() => {
    if (!thread) return null;
    const sentiment = (
      thread.triage?.entities as { sentiment?: string } | null | undefined
    )?.sentiment;
    if (sentiment === 'angry' || sentiment === 'frustrated')
      return 'The customer sounds upset - Pati handles these personally';
    if (thread.triage?.intent === 'WHOLESALE')
      return 'Wholesale inquiry - Pati confirms terms and sends the code';
    const text = plainTextFromMessage(latestInboundMsg) || '';
    if (
      /(charge ?back|dispute|lawyer|attorney|legal action|better business bureau|\bbbb\b|small claims|report you|fraud)/i.test(
        text
      )
    )
      return 'Legal or chargeback wording in the message';
    return null;
  }, [thread, latestInboundMsg]);

  const escalateThread = useCallback(async () => {
    setEscalating(true);
    try {
      const res = await fetch(`/api/threads/${threadId}/escalate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: escalationReason || undefined }),
      });
      if (res.ok) {
        setEscalated(true);
        queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
      }
    } finally {
      setEscalating(false);
    }
  }, [escalationReason, threadId, queryClient]);

  const actionTabLabel =
    (thread?.triage?.intent ? ACTION_TAB_INTENTS[thread.triage.intent] : undefined) ||
    (looksLikeUnsub ? 'Unsubscribe' : undefined);

  // When the portaled action panel carries its own reply (the size-exchange
  // approve panel), the composer collapses - the draft must not appear twice.
  // Detected via a marker attribute because the panel is owned by the sidebar.
  const [hasApprovePanel, setHasApprovePanel] = useState(false);
  const [forceComposer, setForceComposer] = useState(false);
  useEffect(() => {
    setForceComposer(false);
  }, [threadId]);
  useEffect(() => {
    // The slot only exists once the thread has loaded (loading state renders
    // without it) - retry until it appears, then observe portal changes.
    let observer: MutationObserver | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const attach = () => {
      const slot = document.getElementById('thread-action-slot');
      if (!slot) return false;
      const check = () =>
        setHasApprovePanel(!!slot.querySelector('[data-approve-panel]'));
      check();
      observer = new MutationObserver(check);
      observer.observe(slot, { childList: true, subtree: true });
      return true;
    };
    if (!attach()) {
      timer = setInterval(() => {
        if (attach() && timer) {
          clearInterval(timer);
          timer = null;
        }
      }, 300);
    }
    return () => {
      observer?.disconnect();
      if (timer) clearInterval(timer);
    };
  }, [thread?.id]);
  const composerCollapsed =
    hasApprovePanel && !forceComposer && thread?.status !== 'TRASHED';

  // True once a resolving action (replacement / pre-prod change / refund /
  // cancel / escalation) has been recorded. The sidebar already shows a clear
  // green "handled" banner, so the draft-stage warnings below are now stale and
  // are hidden to cut the clutter.
  const actionHandled =
    !!thread?.lastActionType && RESOLVED_ACTION_TYPES.includes(thread.lastActionType);

  // Chat-style: open with the newest message in view at the bottom. Bubbles
  // are plain text (no iframes by default), so heights are deterministic and
  // the scroll lands correctly.
  useEffect(() => {
    const t = setTimeout(() => {
      // Scroll the container directly - scrollIntoView would also scroll
      // ancestor containers (the page itself)
      const el = messagesScrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, 50);
    return () => clearTimeout(t);
  }, [thread?.id, thread?.messages?.length]);

  // Mark messages as read when viewing a thread
  useEffect(() => {
    if (!thread?.id) return;

    // Check if there are any unread inbound messages
    const hasUnread = thread.messages?.some(
      (m) => m.direction === 'INBOUND' && !m.isRead
    );

    if (hasUnread) {
      fetch(`/api/threads/${thread.id}/read`, { method: 'POST' })
        .then(() => {
          // Invalidate queries to update unread counts and thread data
          queryClient.invalidateQueries({ queryKey: ['threads'] });
          queryClient.invalidateQueries({ queryKey: ['thread', thread.id] });
        })
        .catch((err) => console.error('Failed to mark messages as read:', err));
    }
  }, [thread?.id, thread?.messages, queryClient]);

  // Fetch related threads from the same customer
  const { data: relatedThreads } = useQuery<RelatedThread[]>({
    queryKey: ['related-threads', thread?.customerEmail],
    queryFn: async () => {
      if (!thread?.customerEmail) return [];
      const res = await fetch(`/api/threads?email=${encodeURIComponent(thread.customerEmail)}&exclude=${threadId}`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.threads || [];
    },
    enabled: !!thread?.customerEmail,
  });

  // Fetch all available tags
  const { data: allTags } = useQuery<TagData[]>({
    queryKey: ['tags'],
    queryFn: async () => {
      const res = await fetch('/api/tags');
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: teamUsers } = useQuery<TeamUser[]>({
    queryKey: ['team-users'],
    queryFn: async () => {
      const res = await fetch('/api/admin/users');
      if (res.status === 403) return [];
      if (!res.ok) throw new Error('Failed to fetch users');
      return res.json();
    },
    staleTime: 30000,
  });

  const assignMutation = useMutation({
    mutationFn: async (userId: string | null) => {
      const res = await fetch(`/api/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignedUserId: userId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to assign');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['thread', threadId] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['threads-open'] });
      setShowAssigneeMenu(false);
    },
  });

  // Add tag to thread
  const addTagMutation = useMutation({
    mutationFn: async (tagId: string) => {
      const res = await fetch(`/api/threads/${threadId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to add tag');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['thread', threadId] });
      setShowTagDropdown(false);
    },
  });

  // Remove tag from thread
  const removeTagMutation = useMutation({
    mutationFn: async (tagId: string) => {
      const res = await fetch(`/api/threads/${threadId}/tags/${tagId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to remove tag');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['thread', threadId] });
    },
  });

  // Fetch inline image attachments as base64
  const fetchAttachments = useCallback(async (messages: Message[]) => {
    const imageAttachments: { id: string; contentId: string }[] = [];

    for (const msg of messages) {
      for (const att of msg.attachments || []) {
        // CID images must be pre-fetched here (authenticated, parent page) and
        // inlined as data URLs: the sandboxed message iframe has an opaque
        // origin, so its own requests to /api/attachments would be rejected.
        if ((att.storagePath || att.contentId) && att.mimeType?.startsWith('image/')) {
          imageAttachments.push({ id: att.id, contentId: att.contentId || att.id });
        }
      }
    }

    if (imageAttachments.length === 0) return;

    const newData: Record<string, string> = {};

    await Promise.all(
      imageAttachments.map(async ({ id, contentId }) => {
        if (attachmentData[id]) return; // Already fetched
        try {
          const res = await fetch(`/api/attachments/${id}`);
          if (!res.ok) return;
          const blob = await res.blob();
          const reader = new FileReader();
          const dataUrl = await new Promise<string>((resolve) => {
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
          });
          newData[id] = dataUrl;
          // Also store by contentId for CID lookup
          if (contentId && contentId !== id) {
            newData[contentId] = dataUrl;
          }
        } catch {
          // Ignore fetch errors
        }
      })
    );

    if (Object.keys(newData).length > 0) {
      setAttachmentData((prev) => ({ ...prev, ...newData }));
    }
  }, [attachmentData]);

  useEffect(() => {
    if (thread?.messages) {
      fetchAttachments(thread.messages);
    }
  }, [thread?.messages, fetchAttachments]);

  // Plain Send (thread stays open): the operator remains on the thread and
  // expects to see the message land, so this one keeps its spinner.
  const sendMutation = useMutation({
    mutationFn: async ({
      html,
      files,
      originalSuggestion,
    }: {
      html: string;
      files?: File[];
      originalSuggestion?: string | null;
    }) => {
      const formData = new FormData();
      formData.append('bodyHtml', html);
      if (originalSuggestion) {
        formData.append('originalSuggestion', originalSuggestion);
      }
      if (files && files.length > 0) {
        for (const file of files) {
          formData.append('attachments', file);
        }
      }

      const res = await fetch(`/api/threads/${threadId}/messages`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.details || err.error || 'Failed to send message');
      }
      return res.json();
    },
    onSuccess: () => {
      composerRef.current?.clear();
      clearReplyDraft(threadId);
      setOriginalSuggestion(null);
      queryClient.invalidateQueries({ queryKey: ['thread', threadId] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
    },
  });

  // Send & Close: advance to the next open email IMMEDIATELY, close the
  // thread optimistically in the caches, and run the SMTP round-trip in the
  // module-level background queue. A failure reverts the status, restores
  // the reply into the draft store, and raises a persistent inbox banner.
  const performSendAndClose = useCallback(
    (html: string, files: File[]) => {
      if (!html.trim()) return;
      const subject = thread?.subject || 'Untitled thread';
      const suggestion = originalSuggestion;
      const sentThreadId = threadId;

      // Advance first (the navigation logic needs the thread still present
      // in the cached list to find "the next one after it")...
      navigateToNextOpenThread();

      // ...then close it optimistically everywhere the inbox reads from.
      setThreadStatusInCaches(queryClient, sentThreadId, 'CLOSED');
      queryClient.setQueryData<Thread>(['thread', sentThreadId], (old) =>
        old ? { ...old, status: 'CLOSED' } : old
      );
      queryClient.setQueryData<{ emails?: number }>(['nav-counts'], (old) =>
        old && typeof old.emails === 'number'
          ? { ...old, emails: Math.max(0, old.emails - 1) }
          : old
      );

      // The reply is on its way - drop the local draft. On failure the
      // background queue puts the exact content back.
      clearReplyDraft(sentThreadId);
      setOriginalSuggestion(null);

      queueBackgroundSend({
        queryClient,
        threadId: sentThreadId,
        subject,
        html,
        files,
        originalSuggestion: suggestion,
      });
    },
    [thread?.subject, originalSuggestion, threadId, navigateToNextOpenThread, queryClient]
  );

  const performPlainSend = useCallback(
    (html: string, files: File[]) => {
      sendMutation.mutate({ html, files, originalSuggestion });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [originalSuggestion]
  );

  // Brand-lint gate in front of both send paths: a reply that trips a hard
  // brand rule (says "Gildan", claims Made in USA, promises a dollar
  // free-shipping threshold, ...) is parked with the warnings shown, and only
  // an explicit "Send anyway" lets it through. Warn-not-block: the operator
  // always stays in charge, but a VA gets the rule at the moment it matters.
  const guardedSend = useCallback(
    (html: string, files: File[], mode: 'plain' | 'close') => {
      const warnings = lintReply(html);
      if (warnings.length > 0) {
        setLintWarnings(warnings);
        setPendingSend({ html, files, mode });
        return;
      }
      if (mode === 'close') performSendAndClose(html, files);
      else performPlainSend(html, files);
    },
    [performSendAndClose, performPlainSend]
  );
  const handlePlainSend = useCallback(
    (html: string, files: File[]) => guardedSend(html, files, 'plain'),
    [guardedSend]
  );
  const handleSendAndClose = useCallback(
    (html: string, files: File[]) => guardedSend(html, files, 'close'),
    [guardedSend]
  );
  const confirmPendingSend = useCallback(() => {
    if (!pendingSend) return;
    const { html, files, mode } = pendingSend;
    setPendingSend(null);
    setLintWarnings([]);
    if (mode === 'close') performSendAndClose(html, files);
    else performPlainSend(html, files);
  }, [pendingSend, performSendAndClose, performPlainSend]);

  const suggestMutation = useMutation({
    mutationKey: ['suggest', threadId], // Reset mutation state when thread changes
    mutationFn: async (params?: { currentDraft?: string; instructions?: string }) => {
      const res = await fetch(`/api/threads/${threadId}/suggest`, {
        method: 'POST',
        headers: params ? { 'Content-Type': 'application/json' } : undefined,
        body: params ? JSON.stringify(params) : undefined,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to generate suggestion');
      }
      // Tag the response with the thread it was generated FOR (the closure
      // threadId at request time) so a late response can never be applied to
      // a different thread the operator has since switched to.
      return { ...(await res.json()), requestedForThreadId: threadId };
    },
    onSuccess: (data) => {
      // CROSS-THREAD GUARD: if the operator switched threads while the AI was
      // generating, this response belongs to the OLD thread. Writing it into
      // the visible composer would persist customer A's draft under customer
      // B's thread (and shadow B's real draft, since local edits win). The
      // draft is already saved server-side for the right thread - just
      // refresh that thread's cache and stop.
      if (
        data.requestedForThreadId !== threadId ||
        data.requestedForThreadId !== activeThreadIdRef.current
      ) {
        queryClient.invalidateQueries({
          queryKey: ['thread', data.requestedForThreadId],
        });
        queryClient.invalidateQueries({ queryKey: ['threads'] });
        return;
      }
      // Store the original suggestion for feedback tracking
      setOriginalSuggestion(data.draft);
      // Convert draft to HTML with <br/> only to avoid extra paragraph spacing
      const htmlDraft = data.draft.replace(/\n/g, '<br/>');
      // Manual Suggest/Refine is operator-initiated - keep it as a local
      // draft so it survives switching away and back.
      composerRef.current?.setHtml(htmlDraft, { persist: true });
      // Store any warnings
      setSuggestionWarnings(data.warnings || []);
      // Clear refine input after successful refinement
      setRefineInstructions('');
      setShowRefineInput(false);
      // The draft was persisted server-side; refresh caches so the thread and
      // inbox reflect the now-READY draft (and a revisit shows it instantly).
      queryClient.invalidateQueries({ queryKey: ['thread', threadId] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
    },
  });

  // Lazy drafts: reply drafts are NOT pre-generated at email arrival anymore -
  // they're generated when a thread is opened, so they always use fresh order
  // data. When an actionable thread opens without a usable draft, kick off
  // generation exactly once (the key ref guards against re-triggering / loops).
  const autoGenKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!thread || !latestInboundMsg) return;
    if (thread.status !== 'OPEN' && thread.status !== 'PENDING') return;
    const intent = thread.triage?.intent;
    if (intent === 'POSITIVE_FEEDBACK' || intent === 'UNSUBSCRIBE' || intent === 'SPAM')
      return;
    const draft = thread.aiDraft;
    const usable =
      !!draft &&
      draft.status === 'READY' &&
      !!draft.body &&
      draft.forMessageId === latestInboundMsg.id;
    if (usable || draft?.status === 'PENDING' || suggestMutation.isPending) return;
    // Generate at most once per distinct draft state. A no-draft thread keys on
    // (thread, inbound message); an existing draft (STALE/FAILED, e.g. after an
    // action) keys on its id+updatedAt, so a fresh STALE regenerates but the
    // post-generation refetch window can't re-fire. Manual "Suggest Reply" can
    // always regenerate beyond this.
    const key = draft
      ? `${draft.id}:${draft.updatedAt}`
      : `${threadId}:${latestInboundMsg.id}:new`;
    if (autoGenKeysRef.current.has(key)) return;
    autoGenKeysRef.current.add(key);
    suggestMutation.mutate(undefined);
  }, [thread, threadId, latestInboundMsg, suggestMutation]);

  const statusMutation = useMutation({
    mutationFn: async (status: string) => {
      const res = await fetch(`/api/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error('Failed to update status');
      return res.json();
    },
    onSuccess: (_, status) => {
      queryClient.invalidateQueries({ queryKey: ['thread', threadId] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
      setThreadStatusInCaches(queryClient, threadId, status);

      // Navigate to next open thread if marked as trashed or closed
      if (status === 'TRASHED' || status === 'CLOSED') {
        navigateToNextOpenThread();
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/threads/${threadId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.details || err.error || 'Failed to delete thread');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['thread', threadId] });
      queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
      const moved = navigateToNextOpenThread();
      if (!moved) {
        onThreadDeleted?.();
      }
    },
  });


  const purgeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/threads/${threadId}?purge=true`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.details || err.error || 'Failed to delete thread');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['thread', threadId] });
      queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
      onThreadDeleted?.();
    },
  });

  // Stable per-message expand toggle so the memoized message list never
  // re-renders because of a new callback identity.
  const toggleOriginal = useCallback((messageId: string) => {
    setManuallyExpandedMessages((prevSet) => {
      const next = new Set(prevSet);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  const onComposerHasContentChange = useCallback((has: boolean) => {
    setHasReplyContent(has);
  }, []);

  // Keyboard shortcuts on the open thread: e/c close, # trash, s snooze,
  // r focuses the reply editor. j/k live in the inbox list. The hook itself
  // ignores keys typed into inputs or the TipTap editor.
  const threadActionable =
    !!thread && thread.status !== 'TRASHED' && !statusMutation.isPending;
  useInboxShortcuts({
    onClose: () => {
      if (threadActionable && thread.status !== 'CLOSED') {
        statusMutation.mutate('CLOSED');
      }
    },
    onTrash: () => {
      if (threadActionable && !deleteMutation.isPending) {
        deleteMutation.mutate();
      }
    },
    onSnooze: () => {
      if (threadActionable && thread.status === 'OPEN') {
        statusMutation.mutate('PENDING');
      }
    },
    onReplyFocus: () => {
      composerRef.current?.focus();
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-gray-500">Loading thread...</div>
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        Thread not found
      </div>
    );
  }


  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* Header */}
      <div className="px-4 py-1.5 border-b bg-white">
        <div>
          {/* Subject on its own line */}
          <div className="flex items-center gap-2 min-w-0 mb-1">
            <h2 className="text-base font-semibold text-gray-900 truncate">{thread.subject}</h2>
            {thread.triage && (
              <span
                className={cn(
                  'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap flex-shrink-0',
                  (INTENT_LABELS[thread.triage.intent] || FALLBACK_INTENT).className
                )}
                title={`AI classified intent (${Math.round(thread.triage.confidence * 100)}% confidence)`}
              >
                {(INTENT_LABELS[thread.triage.intent] || FALLBACK_INTENT).label}
                {thread.triage.confidence < 0.6 ? '?' : ''}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              {/* Assignee */}
              <div className="relative flex-shrink-0" ref={assigneeMenuRef}>
                <button
                  onClick={() => setShowAssigneeMenu((prev) => !prev)}
                  className="inline-flex items-center gap-1"
                >
                  {thread.assignedUser ? (
                    <Badge variant="info">
                      <User className="w-3 h-3 mr-1" />
                      {thread.assignedUser.name}
                    </Badge>
                  ) : (
                    <Badge variant="default">Unassigned</Badge>
                  )}
                  <ChevronDown className="w-3 h-3 text-gray-600" />
                </button>
                {showAssigneeMenu && (
                  <div className="absolute left-0 top-full mt-1 w-56 bg-white border rounded-lg shadow-lg z-20 py-1">
                    <button
                      onClick={() => assignMutation.mutate(null)}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50"
                    >
                      Unassigned
                    </button>
                    <div className="my-1 border-t" />
                    {(teamUsers || [])
                      .filter((u) => u.active)
                      .map((user) => (
                        <button
                          key={user.id}
                          onClick={() => assignMutation.mutate(user.id)}
                          className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 flex items-center gap-2"
                        >
                          <span className="font-medium text-gray-900">
                            {user.name}
                          </span>
                          <span className="text-xs text-gray-600">
                            {user.email}
                          </span>
                        </button>
                      ))}
                    {(teamUsers || []).filter((u) => u.active).length === 0 && (
                      <p className="px-3 py-2 text-sm text-gray-700">
                        No active team members found.
                      </p>
                    )}
                  </div>
                )}
              </div>
              {relatedThreads && relatedThreads.length > 0 && (
                <button
                  onClick={() => setShowRelatedThreads(!showRelatedThreads)}
                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 flex-shrink-0 whitespace-nowrap"
                >
                  <Mail className="w-3 h-3" />
                  {relatedThreads.length} other thread{relatedThreads.length > 1 ? 's' : ''}
                </button>
              )}
              {/* Tags */}
              {thread.tags?.map((tag) => (
                <span
                  key={tag.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0"
                  style={{
                    backgroundColor: `${tag.color}20`,
                    color: tag.color,
                    border: `1px solid ${tag.color}40`,
                  }}
                >
                  <Tag className="w-3 h-3" />
                  {tag.name}
                  <button
                    onClick={() => removeTagMutation.mutate(tag.id)}
                    className="ml-0.5 text-gray-600 hover:text-gray-900"
                    title="Remove tag"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              {/* Add tag */}
              <div className="relative flex-shrink-0" ref={tagMenuRef}>
                <button
                  onClick={() => setShowTagDropdown((prev) => !prev)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-gray-700 border border-dashed border-gray-300 hover:border-gray-400 hover:text-gray-800"
                >
                  <Plus className="w-3 h-3" />
                  Add tag
                </button>
                {showTagDropdown && (
                  <div className="absolute left-0 top-full pt-1 z-20">
                    <div className="w-48 bg-white border rounded-lg shadow-lg py-1 max-h-48 overflow-y-auto">
                      {allTags?.filter((t) => !thread.tags?.some((tt) => tt.id === t.id)).map((tag) => (
                        <button
                          key={tag.id}
                          onClick={() => addTagMutation.mutate(tag.id)}
                          className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 flex items-center gap-2 text-gray-900"
                        >
                          <span
                            className="w-3 h-3 rounded-full"
                            style={{ backgroundColor: tag.color }}
                          />
                          {tag.name}
                        </button>
                      ))}
                      {allTags?.filter((t) => !thread.tags?.some((tt) => tt.id === t.id)).length === 0 && (
                        <p className="px-3 py-2 text-sm text-gray-700">No more tags available</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 flex-shrink-0">
              <span className="text-xs text-gray-500 whitespace-nowrap">
                {thread.messages.length} msg{thread.messages.length !== 1 ? 's' : ''}
              </span>
              {thread.messages.length > 1 && (
                <>
                  <button
                    onClick={() => {
                      const allIds = thread.messages.map((m) => m.id);
                      setManuallyExpandedMessages(new Set(allIds));
                    }}
                    className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1 whitespace-nowrap"
                    title="Show every message as the original email"
                  >
                    <ChevronsUpDown className="w-3 h-3" />
                    Originals
                  </button>
                  <button
                    onClick={() => setManuallyExpandedMessages(new Set())}
                    className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1 whitespace-nowrap"
                    title="Back to conversation bubbles"
                  >
                    <Minimize2 className="w-3 h-3" />
                    Bubbles
                  </button>
                </>
              )}
            {thread.status !== 'TRASHED' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                loading={deleteMutation.isPending}
                title="Move to Trash (#)"
              >
                <Trash2 className="w-4 h-4 mr-1" />
                Trash
              </Button>
            ) : (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => statusMutation.mutate('OPEN')}
                >
                  Restore
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (purgeMutation.isPending) return;
                    const confirmed = window.confirm(
                      'Permanently delete this thread? This cannot be undone.'
                    );
                    if (confirmed) {
                      purgeMutation.mutate();
                    }
                  }}
                  disabled={purgeMutation.isPending}
                  loading={purgeMutation.isPending}
                >
                  <Trash2 className="w-4 h-4 mr-1" />
                  Delete
                </Button>
              </>
            )}

            {/* Status buttons */}
            {thread.status !== 'TRASHED' && (
              <div className="flex items-center gap-2">
                {thread.status === 'CLOSED' ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => statusMutation.mutate('OPEN')}
                    disabled={statusMutation.isPending}
                  >
                    <Mail className="w-4 h-4 mr-1" />
                    Reopen
                  </Button>
                ) : (
                  <>
                    <Button
                      variant={thread.status === 'PENDING' ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => statusMutation.mutate('PENDING')}
                      disabled={
                        statusMutation.isPending || thread.status === 'PENDING'
                      }
                      title="Snooze - mark Pending (s)"
                    >
                      <Clock className="w-4 h-4 mr-1" />
                      Snooze
                    </Button>
                    <Button
                      variant="success"
                      size="sm"
                      onClick={() => statusMutation.mutate('CLOSED')}
                      disabled={statusMutation.isPending}
                      title="Close thread (e)"
                    >
                      <CheckCircle className="w-4 h-4 mr-1" />
                      Close
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
          </div>
        </div>
      </div>

      {/* Related threads panel */}
      {showRelatedThreads && relatedThreads && relatedThreads.length > 0 && (
        <div className="border-b bg-blue-50 p-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium text-blue-900">Other threads from this customer</h4>
            <button onClick={() => setShowRelatedThreads(false)} className="text-blue-600 hover:text-blue-700">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-1">
            {relatedThreads.map((rt) => (
              <div
                key={rt.id}
                className="relative"
                onMouseEnter={() => setHoveredThread(rt.id)}
                onMouseLeave={() => setHoveredThread(null)}
              >
                <button
                  onClick={() => onSelectThread?.(rt.id)}
                  className="w-full text-left px-3 py-2 rounded bg-white hover:bg-blue-100 text-sm flex items-center justify-between"
                >
                  <span className="truncate flex-1">{rt.subject}</span>
                  <span className="text-xs text-gray-500 ml-2">{rt.messageCount} msgs</span>
                  <Badge className="ml-2" variant={rt.status === 'OPEN' ? 'success' : 'default'}>
                    {rt.status}
                  </Badge>
                </button>
                {/* Preview tooltip on hover */}
                {hoveredThread === rt.id && rt.preview && (
                  <div className="absolute left-0 right-0 top-full mt-1 z-30 bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-sm">
                    <p className="text-xs text-gray-500 mb-1">
                      {new Date(rt.lastMessageAt).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
                    </p>
                    <p className="text-gray-700 line-clamp-3">{rt.preview}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      <div ref={messagesScrollRef} className="flex-1 overflow-y-auto px-4 pt-1 pb-2">
        {/* Conversation view: chronological chat bubbles, newest at the
            bottom (auto-scrolled into view). Bodies are quote-stripped text -
            deterministic heights, no iframe resize races. "Original" per
            message shows the real email. */}
        <MessageList
          messages={thread.messages}
          expandedIds={manuallyExpandedMessages}
          onToggleOriginal={toggleOriginal}
          attachmentData={attachmentData}
        />
        {/* Scroll target for auto-scroll to most recent message */}
        <div ref={messagesEndRef} />
      </div>

      {/* Suggested action panel - portaled in by the customer sidebar,
          shown together with the reply composer below */}
      <div
        id="thread-action-slot"
        className={cn(
          'border-t bg-white overflow-y-auto',
          // The approve panel replaces the composer entirely, so it can use
          // the composer's space; other action cards share it with the
          // composer and stay capped tight so the customer message above stays
          // readable.
          hasApprovePanel ? 'max-h-[62vh]' : 'max-h-[24vh]',
          // CSS-only fallback while the sidebar has no action card to
          // portal in (e.g. no matching order found)
          "empty:after:content-['No_matching_order_found_for_this_action_-_check_the_customer_panel'] empty:after:block empty:after:px-4 empty:after:py-2 empty:after:text-sm empty:after:text-gray-500",
          !actionTabLabel && 'hidden'
        )}
      />

      {/* When the approve panel above carries the reply, the composer
          collapses to a thin bar so nothing shows twice */}
      {composerCollapsed && (
        <div className="border-t bg-white px-4 py-1.5 flex items-center justify-between text-xs text-gray-500">
          <span>
            Approving above sends the reply shown in the panel - nothing else
            to write.
          </span>
          <button
            onClick={() => setForceComposer(true)}
            className="text-blue-600 hover:underline flex-shrink-0 ml-2"
          >
            Write a reply instead
          </button>
        </div>
      )}

      {/* Reply composer */}
      <div
        className={cn(
          'border-t px-4 py-2 bg-white',
          composerCollapsed && 'hidden',
          // When an action card is also showing, bound the composer so it
          // can't push the customer's message off-screen - it scrolls within
          // its own space instead.
          actionTabLabel && !composerCollapsed && 'max-h-[44vh] overflow-y-auto'
        )}
      >
        {thread.status === 'TRASHED' && (
          <div className="mb-3 rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
            This thread is in Trash. Restore it to reply.
          </div>
        )}
        {thread.aiDraft?.status === 'READY' &&
          !thread.aiDraft.body &&
          thread.triage?.intent === 'POSITIVE_FEEDBACK' && (
            <div className="mb-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-600 flex items-center gap-2">
              <CheckCircle className="w-4 h-4 flex-shrink-0 text-gray-400" />
              <span>
                Thank-you message - no reply needed. Close the thread, or use
                Suggest Reply if you want to answer anyway.
              </span>
            </div>
          )}
        {thread.aiDraft?.status === 'AWAITING_ACTION' && !hasReplyContent && !actionHandled && (
          <div className="mb-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 flex items-center gap-2">
            <Sparkles className="w-4 h-4 flex-shrink-0" />
            Size exchange detected. Create the replacement in the sidebar and a
            confirmation draft will be prepared automatically. (Or click Suggest Reply to draft now.)
          </div>
        )}
        {thread.aiDraft?.status === 'PENDING' && !hasReplyContent && (
          <div className="mb-2 text-sm text-gray-500 flex items-center gap-2">
            <Sparkles className="w-4 h-4 animate-pulse" />
            AI draft is being generated in the background...
          </div>
        )}
        {suggestMutation.isPending && !refineInstructions && !hasReplyContent && (
          <div className="mb-2 text-sm text-gray-500 flex items-center gap-2">
            <Sparkles className="w-4 h-4 animate-pulse" />
            Generating the reply draft with the latest order data...
          </div>
        )}
        <div className="mb-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => suggestMutation.mutate(undefined)}
              disabled={suggestMutation.isPending || thread.status === 'TRASHED'}
              loading={suggestMutation.isPending && !refineInstructions}
            >
              <Sparkles className="w-4 h-4 mr-1" />
              Suggest Reply
            </Button>
            {hasReplyContent && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowRefineInput(!showRefineInput)}
                disabled={suggestMutation.isPending || thread.status === 'TRASHED'}
              >
                <Pencil className="w-4 h-4 mr-1" />
                {showRefineInput ? 'Hide' : 'Edit with AI'}
              </Button>
            )}
            {cannedReplies.length > 0 && thread.status !== 'TRASHED' && (
              <div className="relative" ref={cannedMenuRef}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCannedMenu((v) => !v)}
                >
                  <MessageSquareText className="w-4 h-4 mr-1" />
                  Canned
                </Button>
                {showCannedMenu && (
                  <div className="absolute left-0 bottom-full mb-1 w-72 max-h-72 overflow-y-auto bg-white border rounded-lg shadow-lg z-30 py-1">
                    {cannedReplies.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => insertCannedReply(r.body)}
                        className="w-full text-left px-3 py-2 hover:bg-gray-50"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-900 truncate">{r.title}</span>
                          {r.category && (
                            <span className="text-[10px] bg-gray-100 text-gray-600 px-1 py-0.5 rounded flex-shrink-0">
                              {r.category}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 truncate">{r.body}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {suggestMutation.error && (
              <span className="text-sm text-red-500">
                {suggestMutation.error.message}
              </span>
            )}
            {thread.aiDraft?.status === 'READY' && originalSuggestion && (
              <span
                className="inline-flex items-center gap-1 text-[11px] text-emerald-700 cursor-help"
                title={`AI draft generated from live order data ${formatDateRelative(thread.aiDraft.contextRefreshedAt || thread.aiDraft.updatedAt)} - review, tweak, send`}
              >
                <Sparkles className="w-3 h-3" />
                draft {formatDateRelative(thread.aiDraft.contextRefreshedAt || thread.aiDraft.updatedAt)}
              </span>
            )}
            {suggestionWarnings.length > 0 && !actionHandled && (
              // Collapsed by default - the full list buried the actual email
              // under a wall of amber. The count chip is the toggle.
              <button
                type="button"
                onClick={() => setShowWarnings((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] text-amber-700 hover:text-amber-900 underline decoration-dotted underline-offset-2"
                title={showWarnings ? 'Hide the checks' : 'Show the checks'}
              >
                <AlertTriangle className="w-3 h-3" />
                {suggestionWarnings.length} thing
                {suggestionWarnings.length === 1 ? '' : 's'} to check
              </button>
            )}
          </div>
          {suggestionWarnings.length > 0 && !actionHandled && showWarnings && (
            <ul className="mt-1.5 space-y-1 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2">
              {suggestionWarnings.map((w, i) => (
                <li
                  key={i}
                  className="flex items-start gap-1.5 text-[11px] leading-snug text-amber-800"
                >
                  <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}
          {/* "What the AI saw": confirm the draft was grounded in the right
              orders/items/messages (e.g. that the 2nd order actually reached it). */}
          <div className="mt-1.5">
            <button
              type="button"
              onClick={() => {
                if (!showAiContext && !aiContext && !aiContextLoading) loadAiContext();
                setShowAiContext((v) => !v);
              }}
              className="text-[11px] text-gray-500 hover:text-gray-700 underline"
            >
              {showAiContext ? 'Hide what the AI saw' : 'What the AI saw'}
            </button>
            {showAiContext && (
              <div className="mt-1.5 rounded-md border bg-gray-50 px-2.5 py-2">
                {aiContextLoading && !aiContext ? (
                  <p className="text-[11px] text-gray-500">Loading the AI&apos;s context...</p>
                ) : aiContext ? (
                  <>
                    <p className="mb-1.5 text-[11px] text-gray-600">
                      The AI was given <b>{aiContext.messageCount}</b> message
                      {aiContext.messageCount === 1 ? '' : 's'} and{' '}
                      <b>{aiContext.orderCount}</b> order
                      {aiContext.orderCount === 1 ? '' : 's'}
                      {aiContext.matchedOrder
                        ? ` (focused on ${aiContext.matchedOrder})`
                        : ''}
                      {aiContext.ambiguousOrder ? ' - which order was AMBIGUOUS' : ''}
                      . This is exactly what it read:
                    </p>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 text-[11px] leading-snug text-gray-700">
                      {aiContext.facts || '(no context was assembled)'}
                    </pre>
                  </>
                ) : (
                  <p className="text-[11px] text-gray-500">Could not load the AI context.</p>
                )}
              </div>
            )}
          </div>
          {showRefineInput && (
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                value={refineInstructions}
                onChange={(e) => setRefineInstructions(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && refineInstructions.trim()) {
                    const currentText = (composerRef.current?.getHtml() || '')
                      .replace(/<br\s*\/?>/gi, '\n')
                      .replace(/<[^>]*>/g, '');
                    suggestMutation.mutate({
                      currentDraft: currentText,
                      instructions: refineInstructions.trim(),
                    });
                  }
                }}
                placeholder="e.g., make it shorter, be more formal, add tracking info..."
                className="flex-1 px-3 py-1.5 text-sm border rounded-lg bg-white text-gray-900 placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  const currentText = (composerRef.current?.getHtml() || '')
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<[^>]*>/g, '');
                  suggestMutation.mutate({
                    currentDraft: currentText,
                    instructions: refineInstructions.trim(),
                  });
                }}
                disabled={!refineInstructions.trim() || suggestMutation.isPending}
                loading={suggestMutation.isPending && !!refineInstructions}
              >
                Refine
              </Button>
            </div>
          )}
        </div>
        {viewerRole === 'AGENT' && escalationReason && !actionHandled && (
          <div className="mb-2 flex items-center justify-between gap-3 rounded-md border border-orange-300 bg-orange-50 px-3 py-2">
            <div className="flex items-start gap-2 text-[12px] leading-snug text-orange-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>
                {escalated ? (
                  <>
                    Escalated - this thread is now in <b>Needs attention</b> for
                    Pati. You can move on to the next email.
                  </>
                ) : (
                  <>
                    <b>Consider handing this one to Pati:</b> {escalationReason}.
                  </>
                )}
              </span>
            </div>
            {!escalated && (
              <Button
                variant="secondary"
                size="sm"
                onClick={escalateThread}
                loading={escalating}
              >
                Escalate to Pati
              </Button>
            )}
          </div>
        )}
        <ReplyComposer
          key={threadId}
          ref={composerRef}
          threadId={threadId}
          disabled={thread.status === 'TRASHED'}
          customerEmail={thread.customerEmail}
          sendPending={sendMutation.isPending}
          onSend={handlePlainSend}
          onSendAndClose={handleSendAndClose}
          onHasContentChange={onComposerHasContentChange}
        />
        {pendingSend && lintWarnings.length > 0 && (
          <div className="mt-2 rounded-md border border-red-300 bg-red-50 px-3 py-2">
            <p className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-red-800">
              <AlertTriangle className="h-4 w-4" />
              Hold on - this reply breaks {lintWarnings.length === 1 ? 'a brand rule' : `${lintWarnings.length} brand rules`}:
            </p>
            <ul className="mb-2 space-y-1">
              {lintWarnings.map((w) => (
                <li key={w.rule} className="text-[12px] leading-snug text-red-700">
                  - {w.message}
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setPendingSend(null);
                  setLintWarnings([]);
                }}
              >
                Go back and edit
              </Button>
              <Button variant="ghost" size="sm" onClick={confirmPendingSend}>
                Send anyway
              </Button>
            </div>
          </div>
        )}
        {(sendMutation.error || deleteMutation.error || purgeMutation.error) && (
          <p className="mt-2 text-sm text-red-500 flex items-center gap-1">
            <XCircle className="w-4 h-4" />
            {sendMutation.error?.message ||
              deleteMutation.error?.message ||
              purgeMutation.error?.message}
          </p>
        )}
      </div>
    </div>
  );
}
