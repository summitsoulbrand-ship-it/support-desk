'use client';

/**
 * Messenger DMs view - conversation list + thread detail with pre-drafted
 * replies. Replies are blocked after Meta's 24h messaging window closes.
 */

import { useState, useEffect, useRef, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Send,
  Loader2,
  MessageCircle,
  Clock,
  Sparkles,
  CheckCircle,
} from 'lucide-react';

interface Conversation {
  id: string;
  participantName: string;
  snippet?: string | null;
  unreadCount: number;
  status: 'NEW' | 'IN_PROGRESS' | 'DONE' | 'ESCALATED';
  lastMessageAt: string;
  lastCustomerMessageAt?: string | null;
  aiDraft?: string | null;
  account?: { name: string };
}

interface Message {
  id: string;
  isPage: boolean;
  fromName?: string | null;
  message: string;
  sentAt: string;
}

const URL_RE = /https?:\/\/[^\s)\]]+/g;

/** Meta's auto-generated chat-opener ("Facebook created this chat because...") */
function isFbSystemMessage(text: string): boolean {
  return /^Facebook created this chat/i.test(text.trim());
}

/** Replace raw URLs with short clickable labels so they can't wreck the layout */
function renderMessageText(text: string, light: boolean): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = new RegExp(URL_RE.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const url = m[0];
    let label = url;
    try {
      const u = new URL(url);
      label = u.hostname + (u.pathname.length > 1 || u.search ? '/...' : '');
    } catch {
      label = url.slice(0, 40) + '...';
    }
    parts.push(
      <a
        key={m.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn('underline break-all', light ? 'text-blue-100' : 'text-blue-600')}
      >
        {label}
      </a>
    );
    last = m.index + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function ConversationDetail({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient();
  const [reply, setReply] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['social-conversation', conversationId],
    queryFn: async () => {
      const res = await fetch(`/api/social/conversations/${conversationId}`);
      if (!res.ok) throw new Error('Failed to fetch conversation');
      return res.json();
    },
    refetchInterval: 30000,
  });

  const conversation: (Conversation & { messages: Message[] }) | undefined =
    data?.conversation;
  const withinWindow: boolean = data?.withinWindow ?? false;

  // Pre-fill with the AI draft
  const aiDraft = conversation?.aiDraft;
  useEffect(() => {
    if (aiDraft && !reply.trim()) setReply(aiDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiDraft, conversationId]);

  // Reset on conversation switch
  useEffect(() => {
    setReply('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Chat-style: keep the newest message in view. Scroll the container
  // directly - scrollIntoView also scrolls ancestor containers (the page).
  const messageCount = conversation?.messages?.length ?? 0;
  useEffect(() => {
    const container = endRef.current?.parentElement;
    if (container) container.scrollTop = container.scrollHeight;
  }, [conversationId, messageCount]);

  const sendMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await fetch(`/api/social/conversations/${conversationId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reply', message }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Failed to send');
      return result;
    },
    onSuccess: () => {
      setReply('');
      queryClient.invalidateQueries({ queryKey: ['social-conversation', conversationId] });
      queryClient.invalidateQueries({ queryKey: ['social-conversations'] });
    },
  });

  if (isLoading || !conversation) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-gray-900">{conversation.participantName}</h2>
          <p className="text-xs text-gray-500">
            via {conversation.account?.name || 'Facebook'} Messenger
          </p>
        </div>
        <span
          className={cn(
            'text-xs px-2 py-1 rounded-full',
            conversation.status === 'DONE'
              ? 'bg-emerald-100 text-emerald-700'
              : 'bg-blue-100 text-blue-700'
          )}
        >
          {conversation.status}
        </span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {conversation.messages.map((msg) => {
          // Meta's chat-opener gets a quiet system note, not a giant bubble
          if (!msg.isPage && isFbSystemMessage(msg.message || '')) {
            const url = (msg.message.match(URL_RE) || [])[0];
            return (
              <div key={msg.id} className="flex justify-center">
                <p className="max-w-[85%] text-center text-xs text-gray-400 italic">
                  Facebook opened this chat from{' '}
                  {conversation.participantName}&apos;s comment on a post.
                  {url && (
                    <>
                      {' '}
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-500 not-italic hover:underline"
                      >
                        View the comment
                      </a>
                    </>
                  )}
                </p>
              </div>
            );
          }
          return (
            <div
              key={msg.id}
              className={cn('flex', msg.isPage ? 'justify-end' : 'justify-start')}
            >
              <div
                className={cn(
                  'max-w-[75%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap break-words',
                  msg.isPage
                    ? 'bg-blue-600 text-white rounded-br-sm'
                    : 'bg-gray-100 text-gray-900 rounded-bl-sm'
                )}
              >
                {msg.message ? renderMessageText(msg.message, msg.isPage) : '(attachment)'}
                <div
                  className={cn(
                    'text-[10px] mt-1',
                    msg.isPage ? 'text-blue-200' : 'text-gray-400'
                  )}
                >
                  {formatDistanceToNow(new Date(msg.sentAt), { addSuffix: true })}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {/* Composer */}
      <div className="border-t px-6 py-4">
        {!withinWindow ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 flex items-start gap-2">
            <Clock className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>
              Meta&apos;s 24-hour messaging window has closed for this conversation,
              so the page can&apos;t send a reply right now (Meta policy). If the
              customer messages again, the window reopens and a draft will be ready.
            </span>
          </div>
        ) : (
          <>
            {conversation.aiDraft && reply === conversation.aiDraft && (
              <p className="text-xs text-emerald-700 mb-1 flex items-center gap-1">
                <Sparkles className="w-3 h-3" />
                AI draft loaded - review, tweak, send.
              </p>
            )}
            <div className="flex gap-2">
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = 'auto';
                  el.style.height = Math.min(el.scrollHeight + 2, 220) + 'px';
                }}
                placeholder="Write a reply... (Enter to send, Shift+Enter for a new line)"
                rows={3}
                className="flex-1 border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (reply.trim()) sendMutation.mutate(reply.trim());
                  }
                }}
              />
              <Button
                onClick={() => sendMutation.mutate(reply.trim())}
                disabled={!reply.trim() || sendMutation.isPending}
                className="self-end"
              >
                {sendMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
            {sendMutation.error && (
              <p className="text-xs text-red-600 mt-1">{sendMutation.error.message}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function ConversationsView() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);

  const { data, isLoading } = useQuery<{ conversations: Conversation[] }>({
    queryKey: ['social-conversations'],
    queryFn: async () => {
      const res = await fetch('/api/social/conversations');
      if (!res.ok) throw new Error('Failed to fetch conversations');
      return res.json();
    },
    refetchInterval: 30000,
  });

  const conversations = (data?.conversations || []).filter(
    (c) => showDone || c.status !== 'DONE'
  );

  return (
    <div className="flex-1 flex min-h-0">
      {/* List */}
      <div className="w-96 border-r bg-white flex flex-col">
        <div className="px-4 py-2 border-b flex items-center justify-between">
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
            Conversations
          </span>
          <button
            onClick={() => setShowDone(!showDone)}
            className="text-xs text-blue-600 hover:underline"
          >
            {showDone ? 'Hide done' : 'Show done'}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-6 text-center text-gray-400">
              <Loader2 className="w-5 h-5 animate-spin mx-auto" />
            </div>
          ) : conversations.length === 0 ? (
            <div className="p-6 text-center text-gray-500 text-sm">
              <CheckCircle className="w-8 h-8 mx-auto mb-2 text-gray-300" />
              No conversations waiting. New DMs appear here automatically.
            </div>
          ) : (
            conversations.map((conv) => (
              <button
                key={conv.id}
                onClick={() => setSelectedId(conv.id)}
                className={cn(
                  'w-full text-left px-4 py-3 border-b hover:bg-gray-50',
                  selectedId === conv.id && 'bg-blue-50'
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-gray-900 text-sm">
                    {conv.participantName}
                  </span>
                  <span className="text-xs text-gray-400">
                    {formatDistanceToNow(new Date(conv.lastMessageAt), { addSuffix: true })}
                  </span>
                </div>
                <p className="text-xs text-gray-500 truncate mt-0.5">
                  {conv.snippet || ''}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  {conv.status !== 'DONE' && (
                    <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                      {conv.status === 'NEW' ? 'Needs reply' : conv.status}
                    </span>
                  )}
                  {conv.aiDraft && conv.status !== 'DONE' && (
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                      <Sparkles className="w-3 h-3" />
                      Draft ready
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Detail */}
      <div className="flex-1 bg-white">
        {selectedId ? (
          <ConversationDetail conversationId={selectedId} />
        ) : (
          <div className="h-full flex items-center justify-center text-gray-500">
            <div className="text-center">
              <MessageCircle className="w-12 h-12 mx-auto mb-3 text-gray-300" />
              <p>Select a conversation</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
