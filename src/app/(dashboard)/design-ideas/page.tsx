'use client';

/**
 * Customer-sourced design ideas, and the loop that closes them.
 *
 * Three piles, because those are the only three questions worth asking of an
 * idea: has anybody drawn it, does the customer know, and is it finished. An
 * idea only leaves a pile when the work behind it actually happened - linking
 * a live product moves it to "Tell them", sending the note moves it to "Done".
 */

import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Lightbulb,
  Trash2,
  ExternalLink,
  Search,
  Mail,
  Check,
  Copy,
  X,
  Undo2,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import {
  ideaSearchHint,
  noteTextToHtml,
  productUrl,
} from '@/lib/design-ideas-text';

interface Idea {
  id: string;
  text: string;
  source: string;
  authorName?: string | null;
  customerEmail?: string | null;
  permalink?: string | null;
  note?: string | null;
  status: string;
  productHandle?: string | null;
  productTitle?: string | null;
  productImage?: string | null;
  madeAt?: string | null;
  notifiedAt?: string | null;
  notifiedVia?: string | null;
  createdAt: string;
}

interface ProductHit {
  id: string;
  title: string;
  handle: string;
  imageUrl?: string;
}

type Tab = 'todo' | 'tell' | 'done';

const SOCIAL_SOURCES = ['FACEBOOK', 'INSTAGRAM'];

function pileOf(idea: Idea): Tab {
  if (idea.notifiedAt || idea.status === 'PASSED') return 'done';
  if (idea.status === 'MADE') return 'tell';
  return 'todo';
}

export default function DesignIdeasPage() {
  const queryClient = useQueryClient();
  const [manualText, setManualText] = useState('');
  const [tab, setTab] = useState<Tab>('todo');

  const { data, isLoading } = useQuery<{ ideas: Idea[] }>({
    queryKey: ['design-ideas'],
    queryFn: async () => {
      const res = await fetch('/api/design-ideas');
      if (!res.ok) throw new Error('Failed to load ideas');
      return res.json();
    },
  });

  const addMutation = useMutation({
    mutationFn: async (text: string) => {
      const res = await fetch('/api/design-ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source: 'MANUAL' }),
      });
      if (!res.ok) throw new Error('Failed to save');
      return res.json();
    },
    onSuccess: () => {
      setManualText('');
      queryClient.invalidateQueries({ queryKey: ['design-ideas'] });
    },
  });

  const ideas = useMemo(() => data?.ideas || [], [data]);
  const piles = useMemo(() => {
    const out: Record<Tab, Idea[]> = { todo: [], tell: [], done: [] };
    for (const idea of ideas) out[pileOf(idea)].push(idea);
    return out;
  }, [ideas]);

  const tabs: { key: Tab; label: string; hint: string }[] = [
    { key: 'todo', label: 'To make', hint: 'Nobody has drawn these yet' },
    { key: 'tell', label: 'Tell them', hint: 'Drawn, customer not told yet' },
    { key: 'done', label: 'Done', hint: 'Told, or passed on' },
  ];

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <div className="flex items-center gap-2 mb-1">
          <Lightbulb className="w-5 h-5 text-amber-500" />
          <h1 className="text-xl font-semibold text-gray-900">Design ideas</h1>
        </div>
        <p className="text-sm text-gray-500 mb-5">
          Customer suggestions from comments, emails and reviews. Link the design
          once it exists, then send the customer the link.
        </p>

        {/* Manual add */}
        <div className="flex gap-2 mb-5">
          <input
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            placeholder="Paste a customer quote or write an idea..."
            className="flex-1 border rounded-lg px-3 py-2 text-sm bg-white text-gray-900 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-400"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && manualText.trim()) {
                addMutation.mutate(manualText.trim());
              }
            }}
          />
          <Button
            onClick={() => addMutation.mutate(manualText.trim())}
            disabled={!manualText.trim() || addMutation.isPending}
          >
            Add
          </Button>
        </div>

        {/* Piles */}
        <div className="flex gap-1 mb-4 border-b">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              title={t.hint}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
                tab === t.key
                  ? 'border-amber-500 text-gray-900'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
              <span
                className={`ml-2 text-xs px-1.5 py-0.5 rounded-full ${
                  t.key === 'tell' && piles.tell.length > 0
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-gray-100 text-gray-600'
                }`}
              >
                {piles[t.key].length}
              </span>
            </button>
          ))}
        </div>

        {isLoading ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : piles[tab].length === 0 ? (
          <p className="text-sm text-gray-500">
            {tab === 'todo'
              ? 'Nothing waiting. Use the "Idea" action on a comment, or add one above.'
              : tab === 'tell'
                ? 'Nobody is waiting to hear from you. Link a design on the "To make" tab and it lands here.'
                : 'Nothing finished yet.'}
          </p>
        ) : (
          <div className="space-y-2">
            {piles[tab].map((idea) => (
              <IdeaCard key={idea.id} idea={idea} pile={tab} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function IdeaCard({ idea, pile }: { idea: Idea; pile: Tab }) {
  const queryClient = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [telling, setTelling] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['design-ideas'] });
    queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
  };

  const patchMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch(`/api/design-ideas/${idea.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Failed to update');
      return res.json();
    },
    onSuccess: () => {
      setPicking(false);
      setTelling(false);
      invalidate();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/design-ideas/${idea.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
    },
    onSuccess: invalidate,
  });

  const isSocial = SOCIAL_SOURCES.includes(idea.source);

  return (
    <div className="bg-white border rounded-lg px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">
            {idea.text.length > 600 ? `${idea.text.slice(0, 600)}...` : idea.text}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            {idea.source.toLowerCase()}
            {idea.authorName ? ` · ${idea.authorName}` : ''} ·{' '}
            {formatDistanceToNow(new Date(idea.createdAt), { addSuffix: true })}
            {idea.permalink && (
              <>
                {' · '}
                <a
                  href={idea.permalink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:underline inline-flex items-center gap-0.5"
                >
                  <ExternalLink className="w-3 h-3" />
                  source
                </a>
              </>
            )}
          </p>

          {/* The design that answers it */}
          {idea.productHandle && (
            <div className="mt-2 flex items-center gap-2">
              {idea.productImage && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={idea.productImage}
                  alt=""
                  className="w-8 h-8 rounded object-cover border"
                />
              )}
              <a
                href={productUrl(idea.productHandle)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-teal-700 hover:underline"
              >
                {idea.productTitle}
              </a>
            </div>
          )}

          {idea.notifiedAt && (
            <p className="text-xs text-green-600 mt-2 inline-flex items-center gap-1">
              <Check className="w-3 h-3" />
              Told them{' '}
              {formatDistanceToNow(new Date(idea.notifiedAt), { addSuffix: true })}
              {idea.notifiedVia === 'SOCIAL' ? ' on the comment' : ' by email'}
            </p>
          )}
          {idea.status === 'PASSED' && !idea.notifiedAt && (
            <p className="text-xs text-gray-400 mt-2">Passed on this one</p>
          )}
        </div>

        <button
          onClick={() => deleteMutation.mutate()}
          className="text-gray-300 hover:text-red-500 flex-shrink-0"
          title="Remove idea"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* Actions */}
      <div className="mt-3 flex flex-wrap gap-2">
        {pile === 'todo' && !picking && (
          <>
            <Button size="sm" onClick={() => setPicking(true)}>
              <Search className="w-3.5 h-3.5 mr-1" />
              Link the design
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => patchMutation.mutate({ status: 'PASSED' })}
              disabled={patchMutation.isPending}
            >
              Pass
            </Button>
          </>
        )}

        {pile === 'tell' && !telling && (
          <>
            <Button size="sm" onClick={() => setTelling(true)}>
              <Mail className="w-3.5 h-3.5 mr-1" />
              {isSocial && !idea.customerEmail ? 'Write the reply' : 'Tell them'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPicking(true)}>
              Change design
            </Button>
          </>
        )}

        {pile === 'done' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              patchMutation.mutate(
                idea.notifiedAt ? { notified: null } : { status: 'OPEN' }
              )
            }
            disabled={patchMutation.isPending}
          >
            <Undo2 className="w-3.5 h-3.5 mr-1" />
            {idea.notifiedAt ? 'Not told after all' : 'Put it back'}
          </Button>
        )}
      </div>

      {picking && (
        <ProductPicker
          idea={idea}
          onCancel={() => setPicking(false)}
          onPick={(p) =>
            patchMutation.mutate({
              product: { handle: p.handle, title: p.title, image: p.imageUrl },
            })
          }
          saving={patchMutation.isPending}
        />
      )}

      {telling && (
        <TellPanel
          idea={idea}
          onCancel={() => setTelling(false)}
          onTold={(payload) => patchMutation.mutate(payload)}
        />
      )}
    </div>
  );
}

/** Search the live catalog for the design that answers this request. */
function ProductPicker({
  idea,
  onPick,
  onCancel,
  saving,
}: {
  idea: Idea;
  onPick: (p: ProductHit) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [q, setQ] = useState(() => ideaSearchHint(idea.text));
  const [debounced, setDebounced] = useState(q);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isFetching } = useQuery<{ products: ProductHit[] }>({
    queryKey: ['idea-product-search', debounced],
    queryFn: async () => {
      const res = await fetch(
        `/api/shopify/products/search?q=${encodeURIComponent(debounced)}&limit=6`
      );
      if (!res.ok) return { products: [] };
      return res.json();
    },
    enabled: debounced.trim().length > 1,
  });

  const hits = data?.products || [];

  return (
    <div className="mt-3 border-t pt-3">
      <div className="flex gap-2 items-center">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the store for the design..."
          className="flex-1 border rounded-lg px-3 py-1.5 text-sm bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-400"
        />
        <button
          onClick={onCancel}
          className="text-gray-400 hover:text-gray-600"
          title="Cancel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="mt-2 space-y-1">
        {isFetching && <p className="text-xs text-gray-400">Searching...</p>}
        {!isFetching && debounced.trim().length > 1 && hits.length === 0 && (
          <p className="text-xs text-gray-400">
            Nothing in the store matches that. Try the animal or the phrase.
          </p>
        )}
        {hits.map((p) => (
          <button
            key={p.id}
            disabled={saving}
            onClick={() => onPick(p)}
            className="w-full flex items-center gap-2 text-left px-2 py-1.5 rounded hover:bg-gray-50 disabled:opacity-50"
          >
            {p.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={p.imageUrl}
                alt=""
                className="w-8 h-8 rounded object-cover border"
              />
            )}
            <span className="text-sm text-gray-900 truncate">{p.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The reply itself. Pre-written from the customer's own words and the linked
 * design, editable before it goes, and it only stamps "told" once the send
 * actually succeeded.
 */
function TellPanel({
  idea,
  onTold,
  onCancel,
}: {
  idea: Idea;
  onTold: (payload: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const { data, isLoading } = useQuery<{
    subject: string;
    bodyText: string;
    comment: string;
  }>({
    queryKey: ['idea-note', idea.id],
    queryFn: async () => {
      const res = await fetch(`/api/design-ideas/${idea.id}/note`);
      if (!res.ok) throw new Error('Failed to draft the note');
      return res.json();
    },
  });

  if (isLoading || !data) {
    return <p className="mt-3 border-t pt-3 text-xs text-gray-400">Drafting...</p>;
  }

  // Mounted only once the draft exists, so the editable copy starts from it
  // without a second render pass.
  return <TellForm idea={idea} note={data} onTold={onTold} onCancel={onCancel} />;
}

function TellForm({
  idea,
  note,
  onTold,
  onCancel,
}: {
  idea: Idea;
  note: { subject: string; bodyText: string; comment: string };
  onTold: (payload: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [to, setTo] = useState(idea.customerEmail || '');
  const [subject, setSubject] = useState(note.subject);
  const [body, setBody] = useState(note.bodyText);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/threads/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to,
          toName: idea.authorName || undefined,
          subject,
          bodyHtml: noteTextToHtml(body),
          bodyText: body,
          // Good news we started, not a ticket - it stays out of the inbox
          // unless the customer writes back.
          suppressInbox: true,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || 'Failed to send');
      }
      return json as { thread?: { id: string } };
    },
    onSuccess: (json) => {
      setError(null);
      onTold({ notified: { via: 'EMAIL', threadId: json.thread?.id } });
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="mt-3 border-t pt-3 space-y-2">
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-500 w-14">Email</label>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="No address on file - paste one to email them"
          className="flex-1 border rounded-lg px-3 py-1.5 text-sm bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-400"
        />
        <button
          onClick={onCancel}
          className="text-gray-400 hover:text-gray-600"
          title="Cancel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-500 w-14">Subject</label>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="flex-1 border rounded-lg px-3 py-1.5 text-sm bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-amber-400"
        />
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={10}
        className="w-full border rounded-lg px-3 py-2 text-sm bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-amber-400"
      />

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => sendMutation.mutate()}
          disabled={!to || !subject || !body || sendMutation.isPending}
        >
          <Mail className="w-3.5 h-3.5 mr-1" />
          {sendMutation.isPending ? 'Sending...' : 'Send it'}
        </Button>

        {/* Social ideas often have no address at all - reply on the comment
            instead, then say so here. */}
        {idea.permalink && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await navigator.clipboard.writeText(note.comment);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              <Copy className="w-3.5 h-3.5 mr-1" />
              {copied ? 'Copied' : 'Copy comment reply'}
            </Button>
            <a
              href={idea.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center text-sm text-blue-600 hover:underline px-2"
            >
              <ExternalLink className="w-3.5 h-3.5 mr-1" />
              Open the source
            </a>
          </>
        )}

        <Button
          size="sm"
          variant="ghost"
          onClick={() => onTold({ notified: { via: 'SOCIAL' } })}
        >
          <Check className="w-3.5 h-3.5 mr-1" />
          Told them elsewhere
        </Button>
      </div>
    </div>
  );
}
