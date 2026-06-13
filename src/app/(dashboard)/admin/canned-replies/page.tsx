'use client';

/**
 * Admin: manage canned replies / macros.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Trash2, MessageSquareText, Save } from 'lucide-react';

interface CannedReply {
  id: string;
  title: string;
  category: string | null;
  body: string;
  sortOrder: number;
}

export default function CannedRepliesPage() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState({ title: '', category: '', body: '' });

  const { data, isLoading } = useQuery<{ replies: CannedReply[] }>({
    queryKey: ['canned-replies'],
    queryFn: async () => {
      const res = await fetch('/api/canned-replies');
      if (!res.ok) throw new Error('Failed to load');
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (d: { title: string; category?: string; body: string }) => {
      const res = await fetch('/api/canned-replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d),
      });
      if (!res.ok) throw new Error('Failed to create');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['canned-replies'] });
      setShowAdd(false);
      setDraft({ title: '', category: '', body: '' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/canned-replies/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['canned-replies'] }),
  });

  const replies = data?.replies || [];

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <MessageSquareText className="w-5 h-5 text-gray-700" />
          <h1 className="text-xl font-semibold text-gray-900">Canned Replies</h1>
        </div>
        <Button size="sm" onClick={() => setShowAdd((v) => !v)}>
          <Plus className="w-4 h-4 mr-1" /> New
        </Button>
      </div>
      <p className="text-sm text-gray-600 mb-5">
        Reusable answers agents can drop into a reply with one click (sizing,
        shipping time, returns...).
      </p>

      {showAdd && (
        <div className="mb-5 rounded-lg border bg-gray-50 p-4 space-y-3">
          <Input
            placeholder="Title (e.g. Shipping time)"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
          <Input
            placeholder="Category (optional, e.g. Shipping)"
            value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}
          />
          <textarea
            placeholder="The reply text..."
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            rows={5}
            className="w-full px-3 py-2 border rounded-lg text-sm"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() =>
                createMutation.mutate({
                  title: draft.title,
                  category: draft.category || undefined,
                  body: draft.body,
                })
              }
              loading={createMutation.isPending}
              disabled={!draft.title.trim() || !draft.body.trim()}
            >
              <Save className="w-4 h-4 mr-1" /> Save
            </Button>
            <button
              onClick={() => setShowAdd(false)}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : replies.length === 0 ? (
        <p className="text-sm text-gray-500">No canned replies yet.</p>
      ) : (
        <ul className="space-y-2">
          {replies.map((r) => (
            <li key={r.id} className="rounded-lg border bg-white px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-900">{r.title}</p>
                    {r.category && (
                      <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                        {r.category}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-600 mt-1 whitespace-pre-wrap">{r.body}</p>
                </div>
                <button
                  onClick={() => deleteMutation.mutate(r.id)}
                  className="text-gray-400 hover:text-red-600 flex-shrink-0"
                  title="Delete"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
