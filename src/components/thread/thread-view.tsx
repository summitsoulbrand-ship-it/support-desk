'use client';

/**
 * Thread view component - displays message history and reply composer
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect, useCallback, useRef } from 'react';
import { cn, formatDateFull, formatDateRelative } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { RichTextEditor } from '@/components/ui/rich-text-editor';
import {
  Send,
  Sparkles,
  CheckCircle,
  Clock,
  XCircle,
  User,
  Trash2,
  Paperclip,
  Download,
  X,
  Image,
  FileText,
  Mail,
  Tag,
  Plus,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Pencil,
  ChevronsUpDown,
  Minimize2,
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
}

interface RelatedThread {
  id: string;
  subject: string;
  status: string;
  lastMessageAt: string;
  messageCount: number;
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
          className="text-blue-600 hover:underline break-all"
        >
          {part}
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

export function ThreadView({ threadId, onThreadDeleted, onSelectThread }: ThreadViewProps) {
  const queryClient = useQueryClient();
  const [replyHtml, setReplyHtml] = useState('');
  const [showAssigneeMenu, setShowAssigneeMenu] = useState(false);
  const assigneeMenuRef = useRef<HTMLDivElement | null>(null);

  // Helper to navigate to the next open thread (or clear selection if none)
  const navigateToNextOpenThread = useCallback((): boolean => {
    const openCache =
      queryClient.getQueryData<{ threads: CachedThread[] }>(['threads-open']) ||
      undefined;

    const allCachedThreads = openCache?.threads
      ? [openCache.threads]
      : queryClient
          .getQueriesData<{ threads: CachedThread[] }>({ queryKey: ['threads'] })
          .map(([, data]) => data?.threads || []);

    const seen = new Set<string>();
    const openThreads = allCachedThreads
      .flat()
      .filter((t) => {
        // Exclude current thread since we just closed it
        if (t.id === threadId) return false;
        if (t.status !== 'OPEN' && t.status !== 'PENDING') return false;
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });

    // Navigate to the first available open thread
    if (openThreads.length > 0 && onSelectThread) {
      onSelectThread(openThreads[0].id);
      return true;
    }

    // No more open threads - clear selection
    onThreadDeleted?.();
    return false;
  }, [queryClient, threadId, onSelectThread, onThreadDeleted]);
  const [attachmentData, setAttachmentData] = useState<Record<string, string>>({});
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [showRelatedThreads, setShowRelatedThreads] = useState(false);
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  // Track which messages are manually expanded (older messages start collapsed)
  const [manuallyExpandedMessages, setManuallyExpandedMessages] = useState<Set<string>>(new Set());
  const [suggestionWarnings, setSuggestionWarnings] = useState<string[]>([]);
  const [originalSuggestion, setOriginalSuggestion] = useState<string | null>(null);
  const [refineInstructions, setRefineInstructions] = useState('');
  const [showRefineInput, setShowRefineInput] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Reset state when switching threads
  useEffect(() => {
    setReplyHtml('');
    setSelectedFiles([]);
    setShowRelatedThreads(false);
    setShowTagDropdown(false);
    setShowAssigneeMenu(false);
    setSuggestionWarnings([]);
    setOriginalSuggestion(null);
    setRefineInstructions('');
    setShowRefineInput(false);
    setManuallyExpandedMessages(new Set()); // Reset expanded messages
  }, [threadId]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!showAssigneeMenu) return;
      const target = event.target as Node | null;
      if (assigneeMenuRef.current && target && !assigneeMenuRef.current.contains(target)) {
        setShowAssigneeMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showAssigneeMenu]);

  const { data: thread, isLoading } = useQuery<Thread>({
    queryKey: ['thread', threadId],
    queryFn: async () => {
      const res = await fetch(`/api/threads/${threadId}`);
      if (!res.ok) throw new Error('Failed to fetch thread');
      return res.json();
    },
  });

  // Scroll to most recent message when thread loads
  useEffect(() => {
    if (thread?.messages?.length) {
      // Small delay to ensure DOM is rendered
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
      }, 100);
    }
  }, [thread?.id, thread?.messages?.length]);

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
        if (att.storagePath && att.mimeType?.startsWith('image/')) {
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

  const sendMutation = useMutation({
    mutationFn: async ({
      html,
      closeOnSend,
      files,
      originalSuggestion,
    }: {
      html: string;
      closeOnSend?: boolean;
      files?: File[];
      originalSuggestion?: string | null;
    }) => {
      const formData = new FormData();
      formData.append('bodyHtml', html);
      if (closeOnSend) {
        formData.append('closeOnSend', 'true');
      }
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
    onSuccess: (_, variables) => {
      setReplyHtml('');
      setSelectedFiles([]);
      setOriginalSuggestion(null);
      queryClient.invalidateQueries({ queryKey: ['thread', threadId] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });

      // Navigate to next open thread if this was a send+close
      if (variables.closeOnSend) {
        navigateToNextOpenThread();
      }
    },
  });

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
      return res.json();
    },
    onSuccess: (data) => {
      // Store the original suggestion for feedback tracking
      setOriginalSuggestion(data.draft);
      // Convert draft to HTML with <br/> only to avoid extra paragraph spacing
      const htmlDraft = data.draft.replace(/\n/g, '<br/>');
      setReplyHtml(htmlDraft);
      // Store any warnings
      setSuggestionWarnings(data.warnings || []);
      // Clear refine input after successful refinement
      setRefineInstructions('');
      setShowRefineInput(false);
    },
  });

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
      queryClient.setQueriesData<{ threads: CachedThread[] }>(
        { queryKey: ['threads'] },
        (data) => {
          if (!data?.threads) return data;
          return {
            ...data,
            threads: data.threads.map((t) =>
              t.id === threadId ? { ...t, status } : t
            ),
          };
        }
      );
      queryClient.setQueryData<{ threads: CachedThread[] }>(
        ['threads-open'],
        (data) => {
          if (!data?.threads) return data;
          return {
            ...data,
            threads: data.threads.map((t) =>
              t.id === threadId ? { ...t, status } : t
            ),
          };
        }
      );

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
      onThreadDeleted?.();
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

  // Wrap quoted text in collapsible sections
  const wrapQuotedText = (html: string): string => {
    // Pattern 1: Gmail-style "On [date], [name] wrote:" followed by content
    // This pattern matches the "On ... wrote:" line and everything after it
    const gmailPattern = /(<div[^>]*class="[^"]*gmail_quote[^"]*"[^>]*>[\s\S]*?<\/div>)/gi;

    // Pattern 2: "On [date], [name] wrote:" text pattern
    const wrotePattern = /(On\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d)[^<]*?wrote:[\s\S]*?)$/i;

    // Pattern 3: Blockquote elements
    const blockquotePattern = /(<blockquote[^>]*>[\s\S]*?<\/blockquote>)/gi;

    // First, try to wrap Gmail-style quotes
    let result = html.replace(gmailPattern, (match) => {
      return `<div class="quoted-text-wrapper">
        <button class="quoted-text-toggle" onclick="toggleQuoted(this)">••• Show quoted text</button>
        <div class="quoted-text-content">${match}</div>
      </div>`;
    });

    // If no Gmail quotes found, try the "wrote:" pattern
    if (result === html) {
      result = html.replace(wrotePattern, (match) => {
        return `<div class="quoted-text-wrapper">
          <button class="quoted-text-toggle" onclick="toggleQuoted(this)">••• Show quoted text</button>
          <div class="quoted-text-content">${match}</div>
        </div>`;
      });
    }

    // Also wrap standalone blockquotes that aren't already wrapped
    if (!result.includes('quoted-text-wrapper')) {
      result = result.replace(blockquotePattern, (match) => {
        return `<div class="quoted-text-wrapper">
          <button class="quoted-text-toggle" onclick="toggleQuoted(this)">••• Show quoted text</button>
          <div class="quoted-text-content">${match}</div>
        </div>`;
      });
    }

    return result;
  };

  const renderMessageHtml = (message: Message) => {
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

    // Security: remove scripts and dangerous event handlers (Gmail/Outlook best practice)
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    html = html.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, ''); // onclick, onerror, etc.

    // Strip outer HTML structure from email (we provide our own wrapper)
    // This prevents xmlns attributes from Outlook emails appearing as text
    html = html.replace(/<!DOCTYPE[^>]*>/gi, '');
    html = html.replace(/<html[^>]*>/gi, '');
    html = html.replace(/<\/html>/gi, '');
    html = html.replace(/<head[\s\S]*?<\/head>/gi, '');
    html = html.replace(/<body[^>]*>/gi, '');
    html = html.replace(/<\/body>/gi, '');

    // Convert plain text URLs to clickable links (only if not already in an anchor tag)
    // This regex matches URLs that are NOT preceded by href=" or src=" or already in an anchor
    html = html.replace(
      /(?<!href=["']|src=["']|<a[^>]*>)(https?:\/\/[^\s<>"']+)/gi,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );

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

  /* Quoted text collapsing */
  .quoted-text-wrapper {
    margin-top: 1em;
  }
  .quoted-text-content {
    display: none;
    margin-top: 0.5em;
  }
  .quoted-text-content.expanded {
    display: block;
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
  }
  .quoted-text-toggle:hover {
    background: #e5e7eb;
    color: #374151;
  }
</style>
<script>
  function toggleQuoted(btn) {
    var content = btn.nextElementSibling;
    if (content.classList.contains('expanded')) {
      content.classList.remove('expanded');
      btn.innerHTML = '••• Show quoted text';
    } else {
      content.classList.add('expanded');
      btn.innerHTML = '▾ Hide quoted text';
    }
    // Trigger resize event for iframe height adjustment
    window.dispatchEvent(new Event('load'));
  }
</script>
</head>
<body>${wrapQuotedText(html)}</body>
</html>`;
  };

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* Header */}
      <div className="p-4 border-b bg-white">
        <div>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">{thread.subject}</h2>
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500">
                {thread.messages.length} message{thread.messages.length !== 1 ? 's' : ''}
              </span>
              {thread.messages.length > 1 && (
                <>
                  <button
                    onClick={() => {
                      const allIds = thread.messages.slice(0, -1).map(m => m.id);
                      setManuallyExpandedMessages(new Set(allIds));
                    }}
                    className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
                    title="Expand all messages"
                  >
                    <ChevronsUpDown className="w-3 h-3" />
                    Expand all
                  </button>
                  <button
                    onClick={() => setManuallyExpandedMessages(new Set())}
                    className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
                    title="Collapse all messages"
                  >
                    <Minimize2 className="w-3 h-3" />
                    Collapse all
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-gray-500">
            <span>{thread.customerName || thread.customerEmail}</span>
            <div className="relative" ref={assigneeMenuRef}>
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
                className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700"
              >
                <Mail className="w-3 h-3" />
                {relatedThreads.length} other thread{relatedThreads.length > 1 ? 's' : ''}
              </button>
            )}
          </div>
          {/* Tags */}
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            {thread.tags?.map((tag) => (
              <span
                key={tag.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
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
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* Add tag button */}
          <div
            className="relative"
            onMouseEnter={() => setShowTagDropdown(true)}
            onMouseLeave={() => setShowTagDropdown(false)}
          >
            <button
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

          <div className="flex flex-wrap items-center gap-2 ml-auto">
            {thread.status !== 'TRASHED' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                loading={deleteMutation.isPending}
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
                    >
                      <Clock className="w-4 h-4 mr-1" />
                      Snooze
                    </Button>
                    <Button
                      variant="success"
                      size="sm"
                      onClick={() => statusMutation.mutate('CLOSED')}
                      disabled={statusMutation.isPending}
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
              <button
                key={rt.id}
                onClick={() => onSelectThread?.(rt.id)}
                className="w-full text-left px-3 py-2 rounded bg-white hover:bg-blue-100 text-sm flex items-center justify-between"
              >
                <span className="truncate flex-1">{rt.subject}</span>
                <span className="text-xs text-gray-500 ml-2">{rt.messageCount} msgs</span>
                <Badge className="ml-2" variant={rt.status === 'OPEN' ? 'success' : 'default'}>
                  {rt.status}
                </Badge>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="relative">
          {/* Visual thread connector line */}
          {thread.messages.length > 1 && (
            <div
              className="absolute left-[27px] top-8 bottom-8 w-0.5 bg-gray-200"
              style={{ zIndex: 0 }}
            />
          )}
          <div className="space-y-3 relative" style={{ zIndex: 1 }}>
          {thread.messages.map((message, index) => {
            const isLast = index === thread.messages.length - 1;
            // Last message is always expanded, others are collapsed unless manually expanded
            const isExpanded = isLast || manuallyExpandedMessages.has(message.id);
            const isOutbound = message.direction === 'OUTBOUND';

            // Get preview text for collapsed messages
            const getPreviewText = () => {
              const text = message.bodyText || '';
              const cleaned = text.replace(/\s+/g, ' ').trim();
              return cleaned.length > 100 ? cleaned.slice(0, 100) + '...' : cleaned;
            };

            const toggleExpanded = () => {
              if (isLast) return; // Last message is always expanded
              setManuallyExpandedMessages(prev => {
                const next = new Set(prev);
                if (next.has(message.id)) {
                  next.delete(message.id);
                } else {
                  next.add(message.id);
                }
                return next;
              });
            };

            // Display name: "Me" for outbound, otherwise sender name
            const displayName = isOutbound ? 'Me' : (message.fromName || message.fromAddress);

            return (
              <div
                key={message.id}
                className={cn(
                  'bg-white rounded-lg border shadow-sm overflow-hidden',
                  isOutbound && 'border-blue-200 bg-blue-50/30'
                )}
              >
                {/* Message header - clickable to toggle */}
                <div
                  className={cn(
                    "flex items-center gap-3 p-3",
                    !isLast && "cursor-pointer hover:bg-gray-50"
                  )}
                  onClick={() => !isLast && toggleExpanded()}
                >
                  {!isLast && (
                    <div className="flex-shrink-0 text-gray-400">
                      {isExpanded ? (
                        <ChevronDown className="w-4 h-4" />
                      ) : (
                        <ChevronRight className="w-4 h-4" />
                      )}
                    </div>
                  )}
                  <Avatar
                    name={isOutbound ? 'Me' : (message.fromName || message.fromAddress)}
                    size="sm"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        "text-sm font-medium",
                        isOutbound ? "text-blue-700" : "text-gray-900"
                      )}>
                        {displayName}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className="text-xs text-gray-500 cursor-help"
                        title={formatDateFull(message.sentAt)}
                      >
                        {formatDateRelative(message.sentAt)}
                      </span>
                      {/* Show preview when collapsed */}
                      {!isExpanded && (
                        <span className="text-xs text-gray-400 truncate">
                          — {getPreviewText()}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Message content (expanded) */}
                {isExpanded && (
                  <div className="border-t">
                    {message.bodyHtml ? (
                      <iframe
                        title={`message-${message.id}`}
                        className="w-full border-0"
                        style={{ minHeight: '200px' }}
                        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                        srcDoc={renderMessageHtml(message) || ''}
                        onLoad={(e) => {
                          const iframe = e.currentTarget;
                          const resize = () => {
                            try {
                              const doc = iframe.contentWindow?.document;
                              if (doc?.body) {
                                // Get accurate height including all content
                                const height = Math.max(
                                  doc.body.scrollHeight,
                                  doc.body.offsetHeight,
                                  doc.documentElement?.scrollHeight || 0,
                                  doc.documentElement?.offsetHeight || 0
                                );
                                iframe.style.height = `${height + 32}px`;
                              }
                            } catch {
                              // Ignore sizing errors
                            }
                          };
                          resize();
                          // Resize again after images load
                          iframe.contentWindow?.addEventListener('load', resize);
                          const images = iframe.contentDocument?.querySelectorAll('img');
                          images?.forEach((img) => img.addEventListener('load', resize));
                        }}
                      />
                    ) : (
                      <div className="p-4 text-sm text-gray-800 whitespace-pre-wrap">
                        {linkifyText(message.bodyText || '')}
                      </div>
                    )}

                    {message.attachments.length > 0 && (
                      <div className="p-3 border-t bg-gray-50">
                        <p className="text-xs text-gray-500 mb-2 flex items-center gap-1">
                          <Paperclip className="w-3 h-3" />
                          {message.attachments.length} attachment{message.attachments.length > 1 ? 's' : ''}
                        </p>
                        {/* Show image previews for non-inline images */}
                        {message.attachments.some((att) => att.mimeType?.startsWith('image/') && !att.contentId) && (
                          <div className="flex flex-wrap gap-2 mb-3">
                            {message.attachments
                              .filter((att) => att.mimeType?.startsWith('image/') && !att.contentId)
                              .map((att) => {
                                const src = attachmentData[att.id] || `/api/attachments/${att.id}`;
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
                                      className="max-h-48 max-w-full rounded border border-gray-200 hover:border-blue-400 transition-colors"
                                    />
                                  </a>
                                );
                              })}
                          </div>
                        )}
                        {/* Show download links for all attachments */}
                        <div className="flex flex-wrap gap-2">
                          {message.attachments.map((att) => (
                            <a
                              key={att.id}
                              href={`/api/attachments/${att.id}?download`}
                              download={att.filename}
                              className="inline-flex items-center gap-1 text-xs bg-white hover:bg-gray-100 px-2 py-1.5 rounded border border-gray-200 text-gray-700 hover:text-gray-900 transition-colors"
                            >
                              <Download className="w-3 h-3" />
                              {att.filename}
                              <span className="text-gray-400">({Math.round(att.size / 1024)}KB)</span>
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          </div>
        </div>
        {/* Scroll target for auto-scroll to most recent message */}
        <div ref={messagesEndRef} />
      </div>

      {/* Reply composer */}
      <div className="border-t p-4 bg-white">
        {thread.status === 'TRASHED' && (
          <div className="mb-3 rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
            This thread is in Trash. Restore it to reply.
          </div>
        )}
        <div className="mb-2">
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
            {replyHtml.trim() && (
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
            {suggestMutation.error && (
              <span className="text-sm text-red-500">
                {suggestMutation.error.message}
              </span>
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
                    const currentText = replyHtml
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
                  const currentText = replyHtml
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
        {suggestionWarnings.length > 0 && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
            {suggestionWarnings.map((warning, index) => (
              <p key={index} className="text-sm text-amber-800 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>{warning}</span>
              </p>
            ))}
          </div>
        )}
        <div className="border rounded-lg overflow-hidden">
          <RichTextEditor
            value={replyHtml}
            onChange={setReplyHtml}
            placeholder="Type your reply..."
            disabled={thread.status === 'TRASHED'}
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
                Replying to {thread.customerEmail}
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
                disabled={thread.status === 'TRASHED'}
                className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
              >
                <Paperclip className="w-4 h-4" />
                Attach
              </button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="success"
                size="sm"
                onClick={() =>
                  sendMutation.mutate({
                    html: replyHtml,
                    closeOnSend: true,
                    files: selectedFiles,
                    originalSuggestion,
                  })
                }
                disabled={
                  !replyHtml.trim() ||
                  sendMutation.isPending ||
                  thread.status === 'TRASHED'
                }
                loading={sendMutation.isPending}
              >
                <Send className="w-4 h-4 mr-1" />
                Send &amp; Close
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() =>
                  sendMutation.mutate({ html: replyHtml, files: selectedFiles, originalSuggestion })
                }
                disabled={
                  !replyHtml.trim() ||
                  sendMutation.isPending ||
                  thread.status === 'TRASHED'
                }
                loading={sendMutation.isPending}
              >
                <Send className="w-4 h-4 mr-1" />
                Send
              </Button>
            </div>
          </div>
        </div>
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
