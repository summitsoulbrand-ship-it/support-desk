'use client';

/**
 * Customer-sourced design ideas - comments/emails tagged as inspiration,
 * collected for the weekly design batch.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Lightbulb, Trash2, ExternalLink } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface Idea {
  id: string;
  text: string;
  source: string;
  authorName?: string | null;
  permalink?: string | null;
  note?: string | null;
  createdAt: string;
}

export default function DesignIdeasPage() {
  const queryClient = useQueryClient();
  const [manualText, setManualText] = useState('');

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

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/design-ideas/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['design-ideas'] }),
  });

  const ideas = data?.ideas || [];

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <div className="flex items-center gap-2 mb-1">
          <Lightbulb className="w-5 h-5 text-amber-500" />
          <h1 className="text-xl font-semibold text-gray-900">Design ideas</h1>
        </div>
        <p className="text-sm text-gray-500 mb-5">
          Customer suggestions tagged from comments and emails - raw material
          for new designs.
        </p>

        {/* Manual add */}
        <div className="flex gap-2 mb-6">
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

        {isLoading ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : ideas.length === 0 ? (
          <p className="text-sm text-gray-500">
            Nothing saved yet. Use the &quot;Idea&quot; action on a comment, or
            add one above.
          </p>
        ) : (
          <div className="space-y-2">
            {ideas.map((idea) => (
              <div
                key={idea.id}
                className="bg-white border rounded-lg px-4 py-3 flex items-start gap-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">
                    {idea.text}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    {idea.source.toLowerCase()}
                    {idea.authorName ? ` · ${idea.authorName}` : ''} ·{' '}
                    {formatDistanceToNow(new Date(idea.createdAt), {
                      addSuffix: true,
                    })}
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
                </div>
                <button
                  onClick={() => deleteMutation.mutate(idea.id)}
                  className="text-gray-300 hover:text-red-500 flex-shrink-0"
                  title="Remove idea"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
